import { describe, expect, it } from "vitest";
import {
  formatComfyUIConnectionHost,
  formatComfyUIHost,
  formatComfyUIUrl,
  parseComfyUIUrl,
} from "../../transport/comfyui-url.js";

describe("parseComfyUIUrl", () => {
  it("formats URL authorities without changing configured identity", () => {
    expect(formatComfyUIHost("127.0.0.1")).toBe("127.0.0.1");
    expect(formatComfyUIConnectionHost("127.0.0.1")).toBe("localhost");
    expect(formatComfyUIHost("[::1]")).toBe("[::1]");
    expect(formatComfyUIHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(formatComfyUIUrl("http://127.0.0.1:8189/api")).toBe("http://localhost:8189/api");
    expect(formatComfyUIUrl("http://192.168.1.50:8189/api")).toBe("http://192.168.1.50:8189/api");
  });

  it("parses an IPv6 loopback URL", () => {
    expect(parseComfyUIUrl("http://[::1]:8189")).toEqual({
      host: "[::1]",
      port: 8189,
      ssl: false,
      basePath: "",
    });
  });

  it("parses http with explicit port", () => {
    expect(parseComfyUIUrl("http://127.0.0.1:8188")).toEqual({
      host: "127.0.0.1",
      port: 8188,
      ssl: false,
      basePath: "",
    });
  });

  it("parses https with explicit port", () => {
    expect(parseComfyUIUrl("https://comfy.example.com:8443")).toEqual({
      host: "comfy.example.com",
      port: 8443,
      ssl: true,
      basePath: "",
    });
  });

  it("defaults https to port 443 when omitted", () => {
    expect(parseComfyUIUrl("https://comfy.example.com")).toEqual({
      host: "comfy.example.com",
      port: 443,
      ssl: true,
      basePath: "",
    });
  });

  it("defaults http to port 80 when omitted", () => {
    expect(parseComfyUIUrl("http://comfy.local")).toEqual({
      host: "comfy.local",
      port: 80,
      ssl: false,
      basePath: "",
    });
  });

  it("handles LAN IP with custom port", () => {
    expect(parseComfyUIUrl("http://192.168.1.50:8000")).toEqual({
      host: "192.168.1.50",
      port: 8000,
      ssl: false,
      basePath: "",
    });
  });

  it("throws on unsupported protocol", () => {
    expect(() => parseComfyUIUrl("ftp://host:21")).toThrow(/protocol/i);
  });

  it("throws on a non-URL string", () => {
    expect(() => parseComfyUIUrl("not a url")).toThrow();
  });

  // ── Path prefix (reverse proxy / API gateway, issue #52) ──────────────────
  it("preserves a path prefix", () => {
    expect(parseComfyUIUrl("https://host.example.com/comfyapi")).toEqual({
      host: "host.example.com",
      port: 443,
      ssl: true,
      basePath: "/comfyapi",
    });
  });

  it("strips a trailing slash from the prefix", () => {
    expect(parseComfyUIUrl("https://host:8443/comfyapi/").basePath).toBe("/comfyapi");
  });

  it("preserves a nested path prefix", () => {
    expect(parseComfyUIUrl("https://host/api/comfy").basePath).toBe("/api/comfy");
  });

  it("treats a bare root path as no prefix", () => {
    expect(parseComfyUIUrl("http://127.0.0.1:8188/").basePath).toBe("");
  });
});
