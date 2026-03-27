"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const uuid_1 = require("uuid");
// pdf-parse v1.1.1 exports a simple function
const pdfParse = require('pdf-parse');
class SandboxManager {
    baseDirectory;
    sandboxes;
    constructor(baseDirectory = './sandboxes') {
        this.baseDirectory = baseDirectory;
        this.sandboxes = new Map();
        // Ensure base directory exists
        if (!fs_1.default.existsSync(this.baseDirectory)) {
            fs_1.default.mkdirSync(this.baseDirectory, { recursive: true });
        }
        // Load existing sandboxes from disk
        this.loadSandboxesFromDisk();
    }
    loadSandboxesFromDisk() {
        try {
            if (!fs_1.default.existsSync(this.baseDirectory)) {
                return;
            }
            const items = fs_1.default.readdirSync(this.baseDirectory);
            for (const item of items) {
                const itemPath = path_1.default.join(this.baseDirectory, item);
                const stat = fs_1.default.statSync(itemPath);
                if (stat.isDirectory() && item.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                    // This looks like a sandbox directory (UUID format)
                    const sandboxInfo = {
                        id: item,
                        basePath: itemPath,
                        createdAt: new Date(stat.mtime),
                        protectedFiles: new Set(),
                    };
                    this.sandboxes.set(item, sandboxInfo);
                }
            }
        }
        catch (error) {
            console.error('Error loading sandboxes from disk:', error);
        }
    }
    createSandbox() {
        const id = (0, uuid_1.v4)();
        const basePath = path_1.default.join(this.baseDirectory, id);
        fs_1.default.mkdirSync(basePath, { recursive: true });
        const sandboxInfo = {
            id,
            basePath,
            createdAt: new Date(),
            protectedFiles: new Set(),
        };
        this.sandboxes.set(id, sandboxInfo);
        return sandboxInfo;
    }
    getSandbox(sandboxId) {
        return this.sandboxes.get(sandboxId);
    }
    addSandbox(sandboxId, basePath) {
        const sandboxInfo = {
            id: sandboxId,
            basePath,
            createdAt: new Date(),
            protectedFiles: new Set(),
        };
        this.sandboxes.set(sandboxId, sandboxInfo);
        return sandboxInfo;
    }
    protectFile(sandboxId, filename) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        sandbox.protectedFiles.add(filename);
    }
    isFileProtected(sandboxId, filename) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            return false;
        }
        return sandbox.protectedFiles.has(filename);
    }
    listFilesWithProtection(sandboxId, relativePath = '') {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        if (!fs_1.default.existsSync(fullPath)) {
            return [];
        }
        const items = fs_1.default.readdirSync(fullPath, { withFileTypes: true });
        return items.map(item => {
            const displayName = path_1.default.join(relativePath, item.name);
            const isProtected = !item.isDirectory && sandbox.protectedFiles.has(item.name);
            return {
                path: displayName,
                isDirectory: item.isDirectory(),
                isProtected,
            };
        });
    }
    deleteSandbox(sandboxId) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            return false;
        }
        try {
            fs_1.default.rmSync(sandbox.basePath, { recursive: true, force: true });
            this.sandboxes.delete(sandboxId);
            return true;
        }
        catch (error) {
            console.error(`Error deleting sandbox ${sandboxId}:`, error);
            return false;
        }
    }
    listFiles(sandboxId, relativePath = '') {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        if (!fs_1.default.existsSync(fullPath)) {
            return [];
        }
        const items = fs_1.default.readdirSync(fullPath, { withFileTypes: true });
        return items.map(item => {
            const displayName = path_1.default.join(relativePath, item.name);
            return item.isDirectory() ? `${displayName}/` : displayName;
        });
    }
    readFile(sandboxId, relativePath) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        // Security check: ensure path is within sandbox
        if (!fullPath.startsWith(sandbox.basePath)) {
            throw new Error('Access denied: path outside sandbox');
        }
        if (!fs_1.default.existsSync(fullPath)) {
            throw new Error(`File not found: ${relativePath}`);
        }
        // Check if it's a PDF file
        const ext = path_1.default.extname(fullPath).toLowerCase();
        if (ext === '.pdf') {
            throw new Error('PDF files cannot be read directly. Please use python_execute with a PDF library like PyPDF2 or pdfplumber to extract text.');
        }
        return fs_1.default.readFileSync(fullPath, 'utf-8');
    }
    async readFileAsync(sandboxId, relativePath) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        // Security check: ensure path is within sandbox
        if (!fullPath.startsWith(sandbox.basePath)) {
            throw new Error('Access denied: path outside sandbox');
        }
        if (!fs_1.default.existsSync(fullPath)) {
            throw new Error(`File not found: ${relativePath}`);
        }
        // Check if it's a PDF file
        const ext = path_1.default.extname(fullPath).toLowerCase();
        if (ext === '.pdf') {
            try {
                const buffer = fs_1.default.readFileSync(fullPath);
                const data = await pdfParse(buffer);
                return data.text;
            }
            catch (err) {
                throw new Error(`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return fs_1.default.readFileSync(fullPath, 'utf-8');
    }
    writeFile(sandboxId, relativePath, content) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        // Security check: ensure path is within sandbox
        if (!fullPath.startsWith(sandbox.basePath)) {
            throw new Error('Access denied: path outside sandbox');
        }
        // Create directory if it doesn't exist
        const dir = path_1.default.dirname(fullPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        fs_1.default.writeFileSync(fullPath, content, 'utf-8');
    }
    deleteFile(sandboxId, relativePath) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        // Security check: ensure path is within sandbox
        if (!fullPath.startsWith(sandbox.basePath)) {
            throw new Error('Access denied: path outside sandbox');
        }
        if (!fs_1.default.existsSync(fullPath)) {
            throw new Error(`File not found: ${relativePath}`);
        }
        // Check if file is protected
        const filename = path_1.default.basename(relativePath);
        if (sandbox.protectedFiles.has(filename)) {
            throw new Error(`Cannot delete protected file: ${filename}`);
        }
        fs_1.default.rmSync(fullPath, { recursive: true, force: true });
    }
    createDirectory(sandboxId, relativePath) {
        const sandbox = this.sandboxes.get(sandboxId);
        if (!sandbox) {
            throw new Error('Sandbox not found');
        }
        const fullPath = path_1.default.join(sandbox.basePath, relativePath);
        // Security check: ensure path is within sandbox
        if (!fullPath.startsWith(sandbox.basePath)) {
            throw new Error('Access denied: path outside sandbox');
        }
        fs_1.default.mkdirSync(fullPath, { recursive: true });
    }
    getAllSandboxes() {
        return Array.from(this.sandboxes.values());
    }
}
exports.SandboxManager = SandboxManager;
//# sourceMappingURL=sandboxManager.js.map