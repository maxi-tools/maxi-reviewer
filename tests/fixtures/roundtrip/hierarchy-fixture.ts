export function roundTripHierarchyFixture(userInput: string): string {
  const rawToken = "test-token-123";
  const html = "<section>" + userInput + "</section>";
  setTimeout(() => {
    throw new Error("round-trip fixture timer");
  }, 10);
  return rawToken + html;
}
