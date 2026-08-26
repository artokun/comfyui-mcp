const res = await fetch('http://127.0.0.1:8188/internal/logs');
const text = await res.text();
console.log('First 200 chars:', text.substring(0, 200));
console.log('First char code:', text.charCodeAt(0));
console.log('Contains [ERROR]:', text.includes('[ERROR]'));
console.log('Lines (first 3):', text.split('\n').slice(0, 3).map(l => l.substring(0, 80)));
