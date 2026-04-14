export function setGitHubOutput(key: string, value: string) {
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    Bun.file(ghOutput).writer().write(`${key}=${value}\n`);
  }
}
