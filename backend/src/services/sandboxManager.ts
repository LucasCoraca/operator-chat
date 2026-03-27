import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// pdf-parse v1.1.1 exports a simple function
const pdfParse = require('pdf-parse');

export interface SandboxInfo {
  id: string;
  basePath: string;
  createdAt: Date;
  protectedFiles: Set<string>;
}

export interface FileListItem {
  path: string;
  isDirectory: boolean;
  isProtected: boolean;
}

export class SandboxManager {
  private baseDirectory: string;
  private sandboxes: Map<string, SandboxInfo>;

  constructor(baseDirectory: string = './sandboxes') {
    this.baseDirectory = baseDirectory;
    this.sandboxes = new Map();
    
    // Ensure base directory exists
    if (!fs.existsSync(this.baseDirectory)) {
      fs.mkdirSync(this.baseDirectory, { recursive: true });
    }
    
    // Load existing sandboxes from disk
    this.loadSandboxesFromDisk();
  }

  loadSandboxesFromDisk(): void {
    try {
      if (!fs.existsSync(this.baseDirectory)) {
        return;
      }

      const items = fs.readdirSync(this.baseDirectory);
      for (const item of items) {
        const itemPath = path.join(this.baseDirectory, item);
        const stat = fs.statSync(itemPath);
        
        if (stat.isDirectory() && item.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          // This looks like a sandbox directory (UUID format)
          const sandboxInfo: SandboxInfo = {
            id: item,
            basePath: itemPath,
            createdAt: new Date(stat.mtime),
            protectedFiles: new Set(),
          };
          this.sandboxes.set(item, sandboxInfo);
        }
      }
    } catch (error) {
      console.error('Error loading sandboxes from disk:', error);
    }
  }

  createSandbox(): SandboxInfo {
    const id = uuidv4();
    const basePath = path.join(this.baseDirectory, id);
    
    fs.mkdirSync(basePath, { recursive: true });
    
    const sandboxInfo: SandboxInfo = {
      id,
      basePath,
      createdAt: new Date(),
      protectedFiles: new Set(),
    };
    
    this.sandboxes.set(id, sandboxInfo);
    return sandboxInfo;
  }

  getSandbox(sandboxId: string): SandboxInfo | undefined {
    return this.sandboxes.get(sandboxId);
  }

  addSandbox(sandboxId: string, basePath: string): SandboxInfo {
    const sandboxInfo: SandboxInfo = {
      id: sandboxId,
      basePath,
      createdAt: new Date(),
      protectedFiles: new Set(),
    };
    this.sandboxes.set(sandboxId, sandboxInfo);
    return sandboxInfo;
  }

  protectFile(sandboxId: string, filename: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }
    sandbox.protectedFiles.add(filename);
  }

  isFileProtected(sandboxId: string, filename: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      return false;
    }
    return sandbox.protectedFiles.has(filename);
  }

  listFilesWithProtection(sandboxId: string, relativePath: string = ''): FileListItem[] {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    if (!fs.existsSync(fullPath)) {
      return [];
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    return items.map(item => {
      const displayName = path.join(relativePath, item.name);
      const isProtected = !item.isDirectory && sandbox.protectedFiles.has(item.name);
      return {
        path: displayName,
        isDirectory: item.isDirectory(),
        isProtected,
      };
    });
  }

  deleteSandbox(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      return false;
    }

    try {
      fs.rmSync(sandbox.basePath, { recursive: true, force: true });
      this.sandboxes.delete(sandboxId);
      return true;
    } catch (error) {
      console.error(`Error deleting sandbox ${sandboxId}:`, error);
      return false;
    }
  }

  listFiles(sandboxId: string, relativePath: string = ''): string[] {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    if (!fs.existsSync(fullPath)) {
      return [];
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    return items.map(item => {
      const displayName = path.join(relativePath, item.name);
      return item.isDirectory() ? `${displayName}/` : displayName;
    });
  }

  readFile(sandboxId: string, relativePath: string): string {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    // Security check: ensure path is within sandbox
    if (!fullPath.startsWith(sandbox.basePath)) {
      throw new Error('Access denied: path outside sandbox');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    // Check if it's a PDF file
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.pdf') {
      throw new Error('PDF files cannot be read directly. Please use python_execute with a PDF library like PyPDF2 or pdfplumber to extract text.');
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  async readFileAsync(sandboxId: string, relativePath: string): Promise<string> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    // Security check: ensure path is within sandbox
    if (!fullPath.startsWith(sandbox.basePath)) {
      throw new Error('Access denied: path outside sandbox');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    // Check if it's a PDF file
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.pdf') {
      try {
        const buffer = fs.readFileSync(fullPath);
        const data = await pdfParse(buffer);
        return data.text;
      } catch (err) {
        throw new Error(`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return fs.readFileSync(fullPath, 'utf-8');
  }

  writeFile(sandboxId: string, relativePath: string, content: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    // Security check: ensure path is within sandbox
    if (!fullPath.startsWith(sandbox.basePath)) {
      throw new Error('Access denied: path outside sandbox');
    }

    // Create directory if it doesn't exist
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  deleteFile(sandboxId: string, relativePath: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    // Security check: ensure path is within sandbox
    if (!fullPath.startsWith(sandbox.basePath)) {
      throw new Error('Access denied: path outside sandbox');
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    // Check if file is protected
    const filename = path.basename(relativePath);
    if (sandbox.protectedFiles.has(filename)) {
      throw new Error(`Cannot delete protected file: ${filename}`);
    }

    fs.rmSync(fullPath, { recursive: true, force: true });
  }

  createDirectory(sandboxId: string, relativePath: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error('Sandbox not found');
    }

    const fullPath = path.join(sandbox.basePath, relativePath);
    
    // Security check: ensure path is within sandbox
    if (!fullPath.startsWith(sandbox.basePath)) {
      throw new Error('Access denied: path outside sandbox');
    }

    fs.mkdirSync(fullPath, { recursive: true });
  }

  getAllSandboxes(): SandboxInfo[] {
    return Array.from(this.sandboxes.values());
  }
}