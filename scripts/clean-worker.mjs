// Remove leftover hardcoded question data from worker.js
// After extracting questions to separate files, remove genQ/genQ2/genQ3 bodies
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, '..', 'worker.js');
let code = readFileSync(workerPath, 'utf-8');

// Find the getQuestions function end marker and delete everything
// between the end of getQuestions and the start of handleLBPost

const startMarker = `  return qs;
}`;
const endMarker = `async function handleLBPost`;

const startIdx = code.indexOf(startMarker, code.indexOf('function getQuestions')) + startMarker.length;
const endIdx = code.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Could not find markers. Start:', startIdx, 'End:', endIdx);
  process.exit(1);
}

const before = code.slice(0, startIdx);
const after = code.slice(endIdx);
const cleaned = before + '\n\n' + after;

writeFileSync(workerPath, cleaned, 'utf-8');
console.log(`✅ Removed ${endIdx - startIdx} chars of leftover question data`);
console.log(`   File size: ${code.length} → ${cleaned.length} bytes (${Math.round((1 - cleaned.length/code.length)*100)}% reduction)`);
