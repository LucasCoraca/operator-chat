import fs from 'fs';
import { SandboxManager } from './src/services/sandboxManager';

async function testPDFReading() {
  const sandboxManager = new SandboxManager('./sandboxes');
  const sandboxId = '8f789bea-d5b1-4e22-b039-367a9c00d2c8';
  const pdfPath = 'cv_2026_en.pdf';

  console.log(`Testing PDF reading for sandbox: ${sandboxId}`);
  console.log(`PDF path: ${pdfPath}`);

  try {
    const text = await sandboxManager.readFileAsync(sandboxId, pdfPath);
    console.log('\n=== PDF CONTENT (first 2000 chars) ===');
    console.log(text.substring(0, 2000));
    console.log('\n=== END OF PREVIEW ===');
    console.log(`\nTotal characters extracted: ${text.length}`);
  } catch (error) {
    console.error('Error reading PDF:', error);
  }
}

testPDFReading();