import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export function normalizePath(p: string): string {
    return path.normalize(p);
}

export function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

export function isPathWithinAllowedDirectories(
    resolvedPath: string,
    allowedDirectories: string[],
): boolean {
    return allowedDirectories.some((dir) => {
        if (dir === path.parse(dir).root) {
            return true;
        }
        return (
            resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)
        );
    });
}

export async function validatePath(
    requestedPath: string,
    allowedDirectories: string[],
): Promise<string> {
    const expandedPath = expandHome(requestedPath);
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);

    const normalizedRequested = normalizePath(absolute);

    // Check if path is within allowed directories
    if (!isPathWithinAllowedDirectories(normalizedRequested, allowedDirectories)) {
        throw new Error(
            `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(
                ', ',
            )}`,
        );
    }

    // Handle symlinks by checking their real path
    try {
        const realPath = await fs.realpath(absolute);
        const normalizedReal = normalizePath(realPath);
        if (!isPathWithinAllowedDirectories(normalizedReal, allowedDirectories)) {
            throw new Error(
                'Access denied - symlink target outside allowed directories',
            );
        }
        return realPath;
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.startsWith('Access denied')
        ) {
            throw error;
        }
        // For new files that don't exist yet, verify parent directory
        const parentDir = path.dirname(absolute);
        try {
            const realParentPath = await fs.realpath(parentDir);
            const normalizedParent = normalizePath(realParentPath);
            if (
                !isPathWithinAllowedDirectories(
                    normalizedParent,
                    allowedDirectories,
                )
            ) {
                throw new Error(
                    'Access denied - parent directory outside allowed directories',
                );
            }
            return absolute;
        } catch {
            throw new Error(`Parent directory does not exist: ${parentDir}`);
        }
    }
}
