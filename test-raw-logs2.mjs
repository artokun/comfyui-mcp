const res = await fetch('http://127.0.0.1:8188/internal/logs');
const text = await res.text();
console.log('Response starts with quote:', text[0] === '"');
console.log('Response ends with quote:', text[text.length - 1] === '"');

// Try parsing as JSON
const parsed = JSON.parse(text);
console.log('\nAfter JSON.parse:');
console.log('First 200 chars:', parsed.substring(0, 200));
console.log('First char code:', parsed.charCodeAt(0));
console.log('Lines (first 3):', parsed.split('\n').slice(0, 3).map(l => l.substring(0, 80)));
console.log('Total lines:', parsed.split('\n').length);
