// Hard rule 6: .env.example lists names only. The one exception is laptop settings that point
// at the docker-compose containers, whose passwords are throwaway LOCAL_ values.

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASS|CRED|SALT|CERT|AUTH)/;
const SHORT_WORD = /^[a-z][a-z0-9-]{0,30}$/;
const NUMBER = /^\d+$/;
const LOCAL_URL =
  /^[a-z]+:\/\/(?:([a-z0-9]+)(?::([a-z0-9-]+))?@)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[a-z0-9_-]*)?$/;

/** Returns one message per problem line; an empty list means the file is fine. */
export function checkEnvExample(text: string): string[] {
  const entries: { line: number; name: string; value: string }[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      problems.push(`line ${index + 1}: not NAME=value`);
      return;
    }
    entries.push({ line: index + 1, name: match[1] ?? '', value: match[2] ?? '' });
  });

  const localPasswords = new Set(
    entries.filter((e) => e.name.startsWith('LOCAL_') && e.value).map((e) => e.value),
  );

  for (const { line, name, value } of entries) {
    if (!value) continue;
    if (name.startsWith('LOCAL_')) {
      if (!SHORT_WORD.test(value)) {
        problems.push(`line ${line}: ${name} must be a short throwaway word`);
      }
      continue;
    }
    if (SECRET_NAME.test(name)) {
      problems.push(`line ${line}: ${name} must be empty here; set it in your own .env`);
      continue;
    }
    const url = LOCAL_URL.exec(value);
    if (url) {
      const password = url[2];
      if (password !== undefined && !localPasswords.has(password)) {
        problems.push(`line ${line}: ${name} has a password that is not a LOCAL_ value`);
      }
      continue;
    }
    if (!SHORT_WORD.test(value) && !NUMBER.test(value)) {
      problems.push(`line ${line}: ${name} has a value that is not a laptop setting`);
    }
  }
  return problems;
}
