import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExtensions } from './load.js';

let dir: string;

const write = async (folder: string, source: string) => {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, 'index.js'), source);
};

beforeAll(async () => {
  // Inside the project: the test runner will not import modules from outside it.
  dir = await mkdtemp(join(process.cwd(), '.tmp-ext-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadExtensions', () => {
  it('finds nothing in a folder that is missing or holds only files', async () => {
    expect(await loadExtensions(join(dir, 'nowhere'))).toEqual([]);
    await writeFile(join(dir, 'README.md'), 'not an extension');
    expect(await loadExtensions(dir)).toEqual([]);
  });

  it('loads each folder with an index, in name order, and skips folders without one', async () => {
    await write('b_second', "export default { key: 'second' };");
    await write('a_first', "export default { key: 'first', setup() {} };");
    await mkdir(join(dir, 'c_no_index'), { recursive: true });
    const found = await loadExtensions(dir);
    expect(found.map((e) => e.key)).toEqual(['first', 'second']);
    expect(typeof found[0]!.setup).toBe('function');
  });

  it('refuses an extension without a usable key, or two with the same key', async () => {
    const bad = await mkdtemp(join(process.cwd(), '.tmp-ext-bad-'));
    await mkdir(join(bad, 'x'), { recursive: true });
    await writeFile(join(bad, 'x', 'index.js'), "export default { key: 'Not Valid' };");
    await expect(loadExtensions(bad)).rejects.toThrow(/must default-export/);

    await rm(bad, { recursive: true, force: true });

    const twins = await mkdtemp(join(process.cwd(), '.tmp-ext-twins-'));
    for (const folder of ['x', 'y']) {
      await mkdir(join(twins, folder), { recursive: true });
      await writeFile(join(twins, folder, 'index.js'), "export default { key: 'same' };");
    }
    await expect(loadExtensions(twins)).rejects.toThrow(/share the key/);
    await rm(twins, { recursive: true, force: true });
  });
});
