/** node:sqlite is marked experimental in Node 22; its one-time warning would land in an MCP client's stderr. */
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: any, ...rest: any[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/SQLite is an experimental feature/.test(text)) return;
  return (original as any)(warning, ...rest);
}) as typeof process.emitWarning;
export {};
