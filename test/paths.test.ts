import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    isPathWithinAllowedDirectories,
    normalizePath,
    validatePath,
} from '../paths.ts';

let tmpDir: string;
let allowedDir: string;
let siblingDir: string;
let allowedDirs: string[];

before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-mcp-'));
    allowedDir = path.join(tmpDir, 'allowed');
    siblingDir = path.join(tmpDir, 'allowed-evil');
    allowedDirs = [normalizePath(path.resolve(allowedDir))];

    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(allowedDir, 'ok.txt'), 'allowed content');
    await fs.writeFile(path.join(siblingDir, 'secret.txt'), 'top secret');
    await fs.mkdir(path.join(allowedDir, 'nested'), { recursive: true });
    await fs.writeFile(
        path.join(allowedDir, 'nested', 'deep.txt'),
        'deep content',
    );
});

after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test('allows a file directly inside the allowed directory', async () => {
    const result = await validatePath(
        path.join(allowedDir, 'ok.txt'),
        allowedDirs,
    );
    assert.equal(await fs.readFile(result, 'utf-8'), 'allowed content');
});

test('allows the allowed directory itself', async () => {
    const result = await validatePath(allowedDir, allowedDirs);
    assert.equal(result, await fs.realpath(allowedDir));
});

test('allows nested files inside the allowed directory', async () => {
    const result = await validatePath(
        path.join(allowedDir, 'nested', 'deep.txt'),
        allowedDirs,
    );
    assert.equal(await fs.readFile(result, 'utf-8'), 'deep content');
});

test('GHSA-xmgx-44qf-f2wq: denies sibling directory sharing the allowed name as a prefix', async () => {
    await assert.rejects(
        validatePath(path.join(siblingDir, 'secret.txt'), allowedDirs),
        /Access denied/,
    );
});

test('denies other prefix-sharing sibling names (-evil, 2, _backup)', async () => {
    for (const suffix of ['-evil', '2', '_backup']) {
        const sibling = `${allowedDir}${suffix}`;
        await fs.mkdir(sibling, { recursive: true });
        await fs.writeFile(path.join(sibling, 'secret.txt'), 'x');
        await assert.rejects(
            validatePath(path.join(sibling, 'secret.txt'), allowedDirs),
            /Access denied/,
        );
    }
});

test('denies ../ traversal that resolves outside the allowed directory', async () => {
    await assert.rejects(
        validatePath(
            path.join(allowedDir, '..', 'allowed-evil', 'secret.txt'),
            allowedDirs,
        ),
        /Access denied/,
    );
});

test('denies paths entirely outside the allowed directory', async () => {
    await assert.rejects(validatePath('/etc/hostname', allowedDirs), /Access denied/);
});

test('denies a symlink inside the allowed directory pointing to a prefix-sharing sibling', async () => {
    const link = path.join(allowedDir, 'evil-link');
    await fs.symlink(siblingDir, link);
    await assert.rejects(
        validatePath(path.join(link, 'secret.txt'), allowedDirs),
        /Access denied/,
    );
});

test('allows a symlink inside the allowed directory pointing back inside it', async () => {
    const link = path.join(allowedDir, 'self-link');
    await fs.symlink(allowedDir, link);
    const result = await validatePath(path.join(link, 'ok.txt'), allowedDirs);
    assert.equal(await fs.readFile(result, 'utf-8'), 'allowed content');
});

test('returns the absolute path for a nonexistent file inside the allowed directory', async () => {
    const target = path.join(allowedDir, 'new-file.txt');
    const result = await validatePath(target, allowedDirs);
    assert.equal(result, path.resolve(target));
});

test('denies a nonexistent file under a prefix-sharing sibling parent', async () => {
    await assert.rejects(
        validatePath(path.join(siblingDir, 'new-file.txt'), allowedDirs),
        /Access denied/,
    );
});

test('denies a nonexistent file with a nonexistent parent outside the allowed directory', async () => {
    await assert.rejects(
        validatePath(
            path.join(tmpDir, 'missing-parent', 'file.txt'),
            allowedDirs,
        ),
        /(Access denied|Parent directory does not exist)/,
    );
});

test('isPathWithinAllowedDirectories: filesystem root as allowed dir permits everything', () => {
    const root = path.parse(process.cwd()).root;
    assert.equal(isPathWithinAllowedDirectories('/etc/hostname', [root]), true);
    assert.equal(
        isPathWithinAllowedDirectories('/anywhere/at/all', [root]),
        true,
    );
});

test('isPathWithinAllowedDirectories: exact match and child vs prefix sibling', () => {
    const allowed = [normalizePath(path.resolve(tmpDir, 'base'))];
    const base = allowed[0];
    assert.equal(isPathWithinAllowedDirectories(base, allowed), true);
    assert.equal(
        isPathWithinAllowedDirectories(`${base}${path.sep}child`, allowed),
        true,
    );
    assert.equal(
        isPathWithinAllowedDirectories(`${base}-evil`, allowed),
        false,
    );
    assert.equal(
        isPathWithinAllowedDirectories(`${base}2`, allowed),
        false,
    );
});

test('isPathWithinAllowedDirectories: multiple allowed directories', () => {
    const a = normalizePath(path.resolve(tmpDir, 'a'));
    const b = normalizePath(path.resolve(tmpDir, 'b'));
    assert.equal(
        isPathWithinAllowedDirectories(`${b}${path.sep}f.txt`, [a, b]),
        true,
    );
    assert.equal(
        isPathWithinAllowedDirectories(`${b}-evil${path.sep}f.txt`, [a, b]),
        false,
    );
});
