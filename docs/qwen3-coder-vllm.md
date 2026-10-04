# Serving Qwen3-Coder on a DGX Spark

This is the recipe for the server `openai_base_url` points at. Standing it up
is a follow-up to the action change that consumes it: the action does not
install vLLM, and it does not take an x86 Linux lane to reach the model. The
review job stays on the runner it already has. The model runs on a Spark.

## Which machines

jasper, pearl, and peridot are the NVIDIA DGX Sparks already in the fleet.
They are ARM64 (Grace Blackwell). Do not schedule this serve on an x86 Linux
runner: the weights and the runtime are built for the Spark, and an x86 box
would either fail the image or silently fall back to a build this recipe does
not describe.

One Spark serves. The other two are spares, not a pool the action load-balances.
Point `openai_base_url` at whichever one is up. Switching hosts is a config
change, not a code change.

## Install

On the Spark, NVIDIA's vLLM container already targets this board. Pin the
image tag you actually pulled; do not float `latest` once a review has passed
against a tag.

```bash
docker pull nvcr.io/nvidia/vllm:25.09-py3
```

The tag above is an example of the shape, not a pin this repo verifies. Confirm
the current DGX Spark tag in NVIDIA's vLLM release notes before the first pull,
and record the digest next to the unit below once it has served a review.

## Weights

Qwen3-Coder-30B-A3B-Instruct fits a Spark and is the model the action sends by
default (`Qwen/Qwen3-Coder-30B-A3B-Instruct`). A larger coder variant is a
decision for the Spark that has to hold it, not for this action: change
`openai_model` to match whatever `--served-model-name` you pass, and leave the
action alone.

```bash
# Once, into a directory the container will mount. Hugging Face cache is fine.
huggingface-cli download Qwen/Qwen3-Coder-30B-A3B-Instruct \
  --local-dir /var/lib/qwen3-coder
```

## Serve

```bash
docker run --rm --name qwen3-coder \
  --gpus all \
  --network host \
  -v /var/lib/qwen3-coder:/model:ro \
  nvcr.io/nvidia/vllm:25.09-py3 \
  vllm serve /model \
    --served-model-name Qwen/Qwen3-Coder-30B-A3B-Instruct \
    --host 0.0.0.0 \
    --port 8000 \
    --max-model-len 32768
```

`--network host` is deliberate. The review job calls this from another fleet
host, and a published port plus a bridge NAT is one more thing to get wrong
for no gain on a machine that is already on the fleet network. Do not expose
8000 past the fleet. vLLM's OpenAI server has no auth unless you pass
`--api-key`; leave that off and leave `openai_api_key` empty, or set both.

Check it before pointing the action at it:

```bash
curl -s http://jasper:8000/v1/models
curl -s http://jasper:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen/Qwen3-Coder-30B-A3B-Instruct","messages":[{"role":"user","content":"reply with the single word pong"}]}'
```

The second call must return a `choices[0].message.content` string. That is the
only field the action reads.

## What the action sends

One `POST {openai_base_url}/chat/completions` per turn, `temperature: 0`, the
review prompt as a user message, and the model id above unless `openai_model`
overrides it. A repair or a retrieval round resends the conversation so far,
because this server has no session to resume. The reply must be a single
`maxi.review.v1.jules-review` JSON object, the same contract Jules already
returns; the action parses it with the same code.

## Wiring

Fallback (Jules first, this server only if Jules returns nothing):

```yaml
openai_base_url: http://jasper:8000/v1
```

Roster reviewer (this server instead of Jules, on its own job, so the two
reviews are both posted):

```yaml
reviewer_backend: openai
openai_base_url: http://jasper:8000/v1
```

`reviewer_backend: qwen` is the same thing. The action does not care which
Spark answered, and it does not retry across jasper, pearl, and peridot. If
the configured host is down, the fallback records the Jules timeout and the
roster job fails naming the endpoint. Picking a live host is an operator
action, which is the right place for it until more than one Spark is serving.
