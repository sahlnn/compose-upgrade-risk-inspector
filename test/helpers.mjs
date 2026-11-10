import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Creates a throw-away compose project from {relativePath: content}. Returns its directory.
export function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

export const SERVER = (extra = '') => `services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:\${IMMICH_VERSION:-release}
    env_file: [.env]
    ports: ['2283:2283']
${extra}
  database:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
`;
