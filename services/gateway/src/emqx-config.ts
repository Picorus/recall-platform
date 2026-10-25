// P2.3.2: fills in the broker's settings (infra/emqx/emqx.conf.template). Secrets come from the
// environment at deploy time (hard rule 6); this only checks each value cannot break the file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EMQX_TEMPLATE = fileURLToPath(
  new URL('../../../infra/emqx/emqx.conf.template', import.meta.url),
);

export interface EmqxValues {
  readonly SSL_PORT: string;
  readonly TCP_BIND: string;
  readonly CERT_DIR: string;
  readonly HOOK_URL: string;
  readonly HOOK_TOKEN: string;
  readonly NODE_COOKIE: string;
}

export function renderEmqxConfig(v: EmqxValues, template = readFileSync(EMQX_TEMPLATE, 'utf8')) {
  for (const [k, value] of Object.entries(v))
    if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(value)) throw new Error(`bad value for ${k}`);
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    const value = (v as unknown as Record<string, string>)[k];
    if (value === undefined) throw new Error(`no value for ${k}`);
    return value;
  });
  return out;
}
