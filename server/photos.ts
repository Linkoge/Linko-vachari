import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDir } from './config';
import { Photo, WorkflowError } from './types';
export async function savePhoto(buffer: Buffer): Promise<Photo> {
  try {
    const input = sharp(buffer, { limitInputPixels: 40_000_000 });
    const meta = await input.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1) throw new Error('format');
    const { data, info } = await input.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
    const id = randomUUID(); await mkdir(join(privateDir, 'photos'), { recursive: true, mode: 0o700 });
    await writeFile(join(privateDir, 'photos', id + '.jpg'), data, { mode: 0o600 });
    return { id, width: info.width, height: info.height };
  } catch { throw new WorkflowError('PHOTO', 'Choose a single JPEG, PNG or WebP photo under 12 MB and 40 megapixels.'); }
}
