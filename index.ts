#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error(
        'Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]',
    );
    process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
    return path.normalize(p);
}

function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map((dir) =>
    normalizePath(path.resolve(expandHome(dir))),
);

// Validate that all directories exist and are accessible
await Promise.all(
    args.map(async (dir) => {
        try {
            const stats = await fs.stat(expandHome(dir));
            if (!stats.isDirectory()) {
                console.error(`Error: ${dir} is not a directory`);
                process.exit(1);
            }
        } catch (error) {
            console.error(`Error accessing directory ${dir}:`, error);
            process.exit(1);
        }
    }),
);

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
    const expandedPath = expandHome(requestedPath);
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);

    const normalizedRequested = normalizePath(absolute);

    // Check if path is within allowed directories
    const isAllowed = allowedDirectories.some((dir) =>
        normalizedRequested.startsWith(dir),
    );
    if (!isAllowed) {
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
        const isRealPathAllowed = allowedDirectories.some((dir) =>
            normalizedReal.startsWith(dir),
        );
        if (!isRealPathAllowed) {
            throw new Error(
                'Access denied - symlink target outside allowed directories',
            );
        }
        return realPath;
    } catch (error) {
        // For new files that don't exist yet, verify parent directory
        const parentDir = path.dirname(absolute);
        try {
            const realParentPath = await fs.realpath(parentDir);
            const normalizedParent = normalizePath(realParentPath);
            const isParentAllowed = allowedDirectories.some((dir) =>
                normalizedParent.startsWith(dir),
            );
            if (!isParentAllowed) {
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

// Schema definitions
const ReadFileArgsSchema = z.object({
    path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string()),
});

const ListDirectoryArgsSchema = z.object({
    path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
    path: z.string(),
});

const SearchFilesArgsSchema = z.object({
    path: z.string(),
    pattern: z.string(),
    excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
    path: z.string(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
    size: number;
    created: Date;
    modified: Date;
    accessed: Date;
    isDirectory: boolean;
    isFile: boolean;
    permissions: string;
}

// Server setup
const server = new Server(
    {
        name: 'readonly-filesystem-server',
        version: '0.2.0',
    },
    {
        capabilities: {
            tools: {},
        },
    },
);

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}

async function searchFiles(
    rootPath: string,
    pattern: string,
    excludePatterns: string[] = [],
): Promise<string[]> {
    const results: string[] = [];

    async function search(currentPath: string) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);

            try {
                // Validate each path before processing
                await validatePath(fullPath);

                // Check if path matches any exclude pattern
                const relativePath = path.relative(rootPath, fullPath);
                const shouldExclude = excludePatterns.some((pattern) => {
                    const globPattern = pattern.includes('*')
                        ? pattern
                        : `**/${pattern}/**`;
                    return minimatch(relativePath, globPattern, { dot: true });
                });

                if (shouldExclude) {
                    continue;
                }

                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }

                if (entry.isDirectory()) {
                    await search(fullPath);
                }
            } catch (error) {
                // Skip invalid paths during search
                continue;
            }
        }
    }

    await search(rootPath);
    return results;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'read_file',
                description:
                    'Read the complete contents of a file from the file system. ' +
                    'Handles various text encodings and provides detailed error messages ' +
                    'if the file cannot be read. Use this tool when you need to examine ' +
                    'the contents of a single file. Only works within allowed directories.',
                inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
            },
            {
                name: 'read_multiple_files',
                description:
                    'Read the contents of multiple files simultaneously. This is more ' +
                    'efficient than reading files one by one when you need to analyze ' +
                    "or compare multiple files. Each file's content is returned with its " +
                    "path as a reference. Failed reads for individual files won't stop " +
                    'the entire operation. Only works within allowed directories.',
                inputSchema: zodToJsonSchema(
                    ReadMultipleFilesArgsSchema,
                ) as ToolInput,
            },
            {
                name: 'list_directory',
                description:
                    'Get a detailed listing of all files and directories in a specified path. ' +
                    'Results clearly distinguish between files and directories with [FILE] and [DIR] ' +
                    'prefixes. This tool is essential for understanding directory structure and ' +
                    'finding specific files within a directory. Only works within allowed directories.',
                inputSchema: zodToJsonSchema(
                    ListDirectoryArgsSchema,
                ) as ToolInput,
            },
            {
                name: 'directory_tree',
                description:
                    'Get a recursive tree view of files and directories as a JSON structure. ' +
                    "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
                    'Files have no children array, while directories always have a children array (which may be empty). ' +
                    'The output is formatted with 2-space indentation for readability. Only works within allowed directories.',
                inputSchema: zodToJsonSchema(
                    DirectoryTreeArgsSchema,
                ) as ToolInput,
            },
            {
                name: 'search_files',
                description:
                    'Recursively search for files and directories matching a pattern. ' +
                    'Searches through all subdirectories from the starting path. The search ' +
                    'is case-insensitive and matches partial names. Returns full paths to all ' +
                    "matching items. Great for finding files when you don't know their exact location. " +
                    'Only searches within allowed directories.',
                inputSchema: zodToJsonSchema(
                    SearchFilesArgsSchema,
                ) as ToolInput,
            },
            {
                name: 'get_file_info',
                description:
                    'Retrieve detailed metadata about a file or directory. Returns comprehensive ' +
                    'information including size, creation time, last modified time, permissions, ' +
                    'and type. This tool is perfect for understanding file characteristics ' +
                    'without reading the actual content. Only works within allowed directories.',
                inputSchema: zodToJsonSchema(
                    GetFileInfoArgsSchema,
                ) as ToolInput,
            },
            {
                name: 'list_allowed_directories',
                description:
                    'Returns the list of directories that this server is allowed to access. ' +
                    'Use this to understand which directories are available before trying to access files.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                    required: [],
                },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const { name, arguments: args } = request.params;

        switch (name) {
            case 'read_file': {
                const parsed = ReadFileArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for read_file: ${parsed.error}`,
                    );
                }
                const validPath = await validatePath(parsed.data.path);
                const content = await fs.readFile(validPath, 'utf-8');
                return {
                    content: [{ type: 'text', text: content }],
                };
            }

            case 'read_multiple_files': {
                const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for read_multiple_files: ${parsed.error}`,
                    );
                }
                const results = await Promise.all(
                    parsed.data.paths.map(async (filePath: string) => {
                        try {
                            const validPath = await validatePath(filePath);
                            const content = await fs.readFile(
                                validPath,
                                'utf-8',
                            );
                            return `${filePath}:\n${content}\n`;
                        } catch (error) {
                            const errorMessage =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            return `${filePath}: Error - ${errorMessage}`;
                        }
                    }),
                );
                return {
                    content: [{ type: 'text', text: results.join('\n---\n') }],
                };
            }

            case 'list_directory': {
                const parsed = ListDirectoryArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for list_directory: ${parsed.error}`,
                    );
                }
                const validPath = await validatePath(parsed.data.path);
                const entries = await fs.readdir(validPath, {
                    withFileTypes: true,
                });
                const formatted = entries
                    .map(
                        (entry) =>
                            `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${
                                entry.name
                            }`,
                    )
                    .join('\n');
                return {
                    content: [{ type: 'text', text: formatted }],
                };
            }

            case 'directory_tree': {
                const parsed = DirectoryTreeArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for directory_tree: ${parsed.error}`,
                    );
                }

                interface TreeEntry {
                    name: string;
                    type: 'file' | 'directory';
                    children?: TreeEntry[];
                }

                async function buildTree(
                    currentPath: string,
                ): Promise<TreeEntry[]> {
                    const validPath = await validatePath(currentPath);
                    const entries = await fs.readdir(validPath, {
                        withFileTypes: true,
                    });
                    const result: TreeEntry[] = [];

                    for (const entry of entries) {
                        const entryData: TreeEntry = {
                            name: entry.name,
                            type: entry.isDirectory() ? 'directory' : 'file',
                        };

                        if (entry.isDirectory()) {
                            const subPath = path.join(currentPath, entry.name);
                            entryData.children = await buildTree(subPath);
                        }

                        result.push(entryData);
                    }

                    return result;
                }

                const treeData = await buildTree(parsed.data.path);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(treeData, null, 2),
                        },
                    ],
                };
            }

            case 'search_files': {
                const parsed = SearchFilesArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for search_files: ${parsed.error}`,
                    );
                }
                const validPath = await validatePath(parsed.data.path);
                const results = await searchFiles(
                    validPath,
                    parsed.data.pattern,
                    parsed.data.excludePatterns,
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                results.length > 0
                                    ? results.join('\n')
                                    : 'No matches found',
                        },
                    ],
                };
            }

            case 'get_file_info': {
                const parsed = GetFileInfoArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(
                        `Invalid arguments for get_file_info: ${parsed.error}`,
                    );
                }
                const validPath = await validatePath(parsed.data.path);
                const info = await getFileStats(validPath);
                return {
                    content: [
                        {
                            type: 'text',
                            text: Object.entries(info)
                                .map(([key, value]) => `${key}: ${value}`)
                                .join('\n'),
                        },
                    ],
                };
            }

            case 'list_allowed_directories': {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Allowed directories:\n${allowedDirectories.join(
                                '\n',
                            )}`,
                        },
                    ],
                };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: 'text', text: `Error: ${errorMessage}` }],
            isError: true,
        };
    }
});

// Start server
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Secure MCP Filesystem Server running on stdio');
    console.error('Allowed directories:', allowedDirectories);
}

runServer().catch((error) => {
    console.error('Fatal error running server:', error);
    process.exit(1);
});
