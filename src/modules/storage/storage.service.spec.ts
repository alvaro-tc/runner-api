import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageService } from './storage.service';

/** Config minima: solo se leen estas dos claves. */
const config = (root: string) =>
  ({ get: (k: string) => (k === 'UPLOADS_DIR' ? root : 'https://x.test') }) as never;

describe('LocalStorageService.assertWritable', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'uploads-'));
  });

  afterEach(async () => {
    await chmod(join(root, 'marathons'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('acepta un directorio propio', async () => {
    await mkdir(join(root, 'marathons', 'qr'), { recursive: true });
    await expect(new LocalStorageService(config(root)).assertWritable()).resolves.toBeUndefined();
  });

  // El fallo real de produccion: uploads/ escribible, marathons/ de root.
  it('detecta un subdirectorio sin permiso de escritura', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod no aplica
    const ajeno = join(root, 'marathons');
    await mkdir(ajeno);
    await chmod(ajeno, 0o555);

    await expect(new LocalStorageService(config(root)).assertWritable()).rejects.toThrow(ajeno);
  });
});
