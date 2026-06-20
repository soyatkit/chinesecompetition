// Extract question banks from worker.js into separate JSON files
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const questionsDir = path.join(root, 'questions');

mkdirSync(questionsDir, { recursive: true });

const worker = readFileSync(path.join(root, 'worker.js'), 'utf-8');

// Helper: extract an object by finding its opening { and matching braces
function extractObject(text, startIdx) {
  let depth = 0;
  let i = startIdx;
  while (i < text.length) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
    i++;
  }
  return null;
}

// Find BANK = { ... } in genQ
const bankMatch = worker.match(/const\s+BANK\s*=\s*(\{[\s\S]*?\});\s*\n\s*const\s+qs/);
// Find BANK_R2 = { ... } in genQ2
const bankR2Match = worker.match(/const\s+BANK_R2\s*=\s*(\{[\s\S]*?\});\s*\n\s*const\s+qs/);
// Find BANK_R3 = { ... } in genQ3
const bankR3Match = worker.match(/const\s+BANK_R3\s*=\s*(\{[\s\S]*?\});\s*\n\s*const\s+qs/);

function parseAndWrite(name, objStr, grades) {
  try {
    const obj = eval(`(${objStr})`);
    for (const g of grades) {
      if (obj[g]) {
        const filePath = path.join(questionsDir, `${name}-${g.toLowerCase()}.json`);
        writeFileSync(filePath, JSON.stringify(obj[g], null, 2), 'utf-8');
        console.log(`✅ Written ${filePath} (${obj[g].length} questions)`);
      }
    }
  } catch (e) {
    console.error(`❌ Failed to parse ${name}:`, e.message);
  }
}

const grades = ['P4', 'P5', 'P6'];

if (bankMatch) {
  console.log('📦 Extracting genQ (Round 1)...');
  parseAndWrite('genQ', bankMatch[1], grades);
} else {
  console.error('❌ Could not find BANK in genQ');
}

if (bankR2Match) {
  console.log('📦 Extracting genQ2 (Round 2)...');
  parseAndWrite('genQ2', bankR2Match[1], grades);
} else {
  console.error('❌ Could not find BANK_R2 in genQ2');
}

if (bankR3Match) {
  console.log('📦 Extracting genQ3 (Round 3)...');
  parseAndWrite('genQ3', bankR3Match[1], grades);
} else {
  console.error('❌ Could not find BANK_R3 in genQ3');
}

console.log('\n🎉 Done! All question banks extracted.');
