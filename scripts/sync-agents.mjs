import fs from 'fs';
import path from 'path';

const PLUGIN_DIR = 'plugin';
const AGENTS_DIR = '.agents';
const GEMINI_DIR = '.gemini/commands';

// Ensure directories exist
fs.mkdirSync(path.join(AGENTS_DIR, 'skills'), { recursive: true });
fs.mkdirSync(GEMINI_DIR, { recursive: true });

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  
  const frontmatterStr = match[1];
  const body = match[2];
  
  const frontmatter = {};
  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (!key.startsWith('globs') && !line.trim().startsWith('-')) {
         frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return { frontmatter, body };
}

function processSkillOrAgent(srcPath, destPath, defaultName, isAgent) {
  if (!fs.existsSync(srcPath)) return;
  const content = fs.readFileSync(srcPath, 'utf8');
  let { frontmatter, body } = extractFrontmatter(content);
  
  const name = frontmatter.name || defaultName;
  const description = frontmatter.description || (isAgent ? `Agent specialized in ${name}` : '');
  
  // Replace CLAUDE_PLUGIN_ROOT with ./plugin
  body = body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, './plugin');
  
  const newContent = `---
name: ${name}
description: ${description}
---

${body.trim()}`;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, newContent, 'utf8');
  console.log(`Synced ${srcPath} -> ${destPath}`);
}

// 1. Translate skills
const skillsDir = path.join(PLUGIN_DIR, 'skills');
if (fs.existsSync(skillsDir)) {
  for (const skillName of fs.readdirSync(skillsDir)) {
    const srcPath = path.join(skillsDir, skillName, 'SKILL.md');
    const destPath = path.join(AGENTS_DIR, 'skills', skillName, 'SKILL.md');
    processSkillOrAgent(srcPath, destPath, skillName, false);
  }
}

// 2. Translate agents
const agentsDir = path.join(PLUGIN_DIR, 'agents');
if (fs.existsSync(agentsDir)) {
  for (const file of fs.readdirSync(agentsDir)) {
    if (file.endsWith('.md')) {
      const agentName = path.basename(file, '.md');
      const srcPath = path.join(agentsDir, file);
      const destPath = path.join(AGENTS_DIR, 'skills', `comfy-${agentName}`, 'SKILL.md');
      processSkillOrAgent(srcPath, destPath, `comfy-${agentName}`, true);
    }
  }
}

// 3. Translate commands
const commandsDir = path.join(PLUGIN_DIR, 'commands');
if (fs.existsSync(commandsDir)) {
  for (const file of fs.readdirSync(commandsDir)) {
    if (file.endsWith('.md')) {
      const commandName = path.basename(file, '.md');
      const srcPath = path.join(commandsDir, file);
      const destPath = path.join(GEMINI_DIR, `comfy-${commandName}.toml`);
      
      const content = fs.readFileSync(srcPath, 'utf8');
      let { frontmatter, body } = extractFrontmatter(content);
      
      body = body.replace(/\$ARGUMENTS/g, '{{args}}');
      body = body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, './plugin');
      
      const desc = frontmatter.description || `Command comfy-${commandName}`;
      
      const tomlContent = `name = "comfy-${commandName}"
description = "${desc}"

prompt = """
${body.trim()}
"""
`;
      fs.writeFileSync(destPath, tomlContent, 'utf8');
      console.log(`Synced ${srcPath} -> ${destPath}`);
    }
  }
}

// 4. Translate hooks
const hooksSrc = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
const hooksDest = path.join(AGENTS_DIR, 'hooks.json');
if (fs.existsSync(hooksSrc)) {
  let hooksContent = fs.readFileSync(hooksSrc, 'utf8');
  hooksContent = hooksContent.replace(/mcp__plugin_comfy_comfyui__/g, 'mcp__comfyui__');
  hooksContent = hooksContent.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks/g, './plugin/hooks');
  hooksContent = hooksContent.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts/g, './plugin/scripts');
  fs.writeFileSync(hooksDest, hooksContent, 'utf8');
  console.log(`Synced hooks -> ${hooksDest}`);
}

// 5. Create default mcp_config.json
const mcpConfigPath = path.join(AGENTS_DIR, 'mcp_config.json');
const mcpConfig = {
  mcpServers: {
    comfyui: {
      command: "npx",
      args: ["-y", "comfyui-mcp"],
      env: {
        CIVITAI_API_TOKEN: ""
      }
    },
    civitai: {
      url: "https://mcp.civitai.com/mcp",
      headers: {
        Authorization: "Bearer ${CIVITAI_API_TOKEN:-}"
      }
    },
    huggingface: {
      url: "https://huggingface.co/mcp",
      headers: {
        Authorization: "Bearer ${HUGGINGFACE_TOKEN:-}"
      }
    }
  }
};
fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
console.log(`Created default ${mcpConfigPath}`);