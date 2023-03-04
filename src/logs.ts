export function log(...logs: any[]) {
  console.log(logs.map((logLine) => JSON.stringify(logLine)).join(' '));
}
