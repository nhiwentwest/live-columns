import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourceFiles = [
    'main.ts',
    'liveColumnsExtension.ts',
];

const prohibitedPatterns = [
    {
        label: 'innerHTML access',
        pattern: /\binnerHTML\b/,
    },
    {
        label: 'direct element.style access',
        pattern: /\.\s*style\s*\./,
    },
];

const violations = [];

for (const file of sourceFiles) {
    const contents = readFileSync(join(process.cwd(), file), 'utf8');
    const lines = contents.split('\n');

    lines.forEach((line, index) => {
        for (const { label, pattern } of prohibitedPatterns) {
            if (pattern.test(line)) {
                violations.push(`${file}:${index + 1} uses ${label}`);
            }
        }
    });
}

assert.deepEqual(violations, []);
