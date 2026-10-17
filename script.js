// ==UserScript==
// @name         1v1
// @namespace    local.diep.fov-editor
// @version      0.15.2-current-wasm
// @description  Camera zoom, normal-FOV outline, and estimated drone cursor visualization.
// @match        https://diep.io/*
// @match        https://www.diep.io/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/* Camera-only patches for verified client builds. See FOV-README.md. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepFovWasm = api;
})(globalThis, function () {
  'use strict';
  const EXPORT_NAME = '__diepFovMultiplier';
  const PROFILE = Object.freeze({
    sha256: '7ac1a1659ee8514ded697b39a218811d6c7318f6f6ffa12b5fe1763633610668',
    byteLength: 5972989, importedFunctions: 57, importedGlobals: 0, definedFunctions: 2105, globals: 1,
    sites: Object.freeze([21172, 68993].map(offset => Object.freeze({
      functionIndex: 1588, bodySize: 216273, offset, guardOffset: offset - 8,
      guard: Object.freeze([234,207,212,211,1,115,190,148,188,34,2,65,16,118,65,245])
    })))
  });
  const CURRENT_PROFILE = Object.freeze({
    sha256: 'd95b0afa7892bb9581b96939a41a7e22cc0e7a40c8b2c70d4faede66d3183126',
    byteLength: 5982383, importedFunctions: 57, importedGlobals: 0, definedFunctions: 2144, globals: 1,
    sites: Object.freeze([17809, 67091].map(offset => Object.freeze({
      functionIndex: 2030, bodySize: 223515, offset, guardOffset: offset - 8,
      guard: Object.freeze([227,204,227,149,3,115,190,148,188,34,5,65,16,118,65,184,127,115,32,5])
    })))
  });
  const PROFILES = Object.freeze([CURRENT_PROFILE, PROFILE]);
  const ORDER = [1,2,3,4,5,13,6,7,8,9,12,10,11];
  const rank = id => ORDER.indexOf(id);
  function bytesOf(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected WASM bytes');
  }
  function u32(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('Invalid integer');
    const out=[];
    do { let b=n%128; n=Math.floor(n/128); if(n)b|=128; out.push(b); } while(n);
    return Uint8Array.from(out);
  }
  function concat(...parts) {
    const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0;
    for(const p of parts) { out.set(p,at); at+=p.length; } return out;
  }
  class Reader {
    constructor(bytes) { this.bytes=bytes; this.at=0; }
    byte() { if(this.at>=this.bytes.length)throw new Error('Truncated WASM'); return this.bytes[this.at++]; }
    u32() {
      let n=0;
      for(let i=0;i<5;i++) { const b=this.byte(); if(i===4&&(b&240))throw new Error('Invalid LEB'); n+=(b&127)*2**(7*i); if(!(b&128))return n; }
      throw new Error('Invalid LEB');
    }
    take(n) { if(n<0||n>this.bytes.length-this.at)throw new Error('Truncated section'); const b=this.bytes.subarray(this.at,this.at+n); this.at+=n; return b; }
    name() { return new TextDecoder('utf-8',{fatal:true}).decode(this.take(this.u32())); }
    end() { if(this.at!==this.bytes.length)throw new Error('Unexpected section bytes'); }
  }
  function limits(r) { const f=r.u32(); if(f>3)throw new Error('Unsupported limits'); r.u32(); if(f&1)r.u32(); }
  function section(id,payload) { return concat(Uint8Array.of(id),u32(payload.length),payload); }
  function vector(payload) { if(!payload)return {count:0,entries:new Uint8Array()}; const r=new Reader(payload); return {count:r.u32(),entries:r.take(r.bytes.length-r.at)}; }

  // This low-level helper accepts a trusted profile for synthetic tests. Production uses
  // prepareWasm(), which checks the entire original binary before these offsets are used.
  function patchWasm(input, profile) {
    let original;
    try { original=bytesOf(input); } catch(error) { return {patched:false,reason:error.message,bytes:input}; }
    const fail=reason=>({patched:false,reason,bytes:original});
    try {
      if(!profile || !profile.sites?.length) return fail('Missing camera profile');
      if(original.length!==profile.byteLength)return fail('Profile mismatch: byteLength');
      if(!WebAssembly.validate(original))return fail('Original WASM does not validate');
      const r=new Reader(original); r.take(8); const sections=[],byId=new Map(); let last=-1;
      while(r.at<original.length) {
        const id=r.byte(),payload=r.take(r.u32());
        if(id) { if(rank(id)<0||rank(id)<=last)throw new Error('Unsupported section order'); last=rank(id); byId.set(id,payload); }
        sections.push({id,payload});
      }
      let importedFunctions=0,importedGlobals=0;
      if(byId.has(2)) {
        const i=new Reader(byId.get(2)),count=i.u32();
        for(let n=0;n<count;n++) {
          i.name(); i.name(); const kind=i.byte();
          if(kind===0) { i.u32(); importedFunctions++; }
          else if(kind===1) { i.byte(); limits(i); }
          else if(kind===2)limits(i);
          else if(kind===3) { i.byte(); i.byte(); importedGlobals++; }
          else if(kind===4) { i.byte(); i.u32(); }
          else throw new Error('Unsupported import');
        } i.end();
      }
      const globalVector=vector(byId.get(6)),exportVector=vector(byId.get(7));
      const functions=vector(byId.get(3));
      for(const [actual,key] of [[importedFunctions,'importedFunctions'],[importedGlobals,'importedGlobals'],[functions.count,'definedFunctions'],[globalVector.count,'globals']]) {
        if(actual!==profile[key])return fail(`Profile mismatch: ${key}`);
      }
      const e=new Reader(exportVector.entries);
      for(let n=0;n<exportVector.count;n++) { if(e.name()===EXPORT_NAME)return fail('Multiplier export already exists'); e.byte();e.u32(); } e.end();
      if(!byId.has(10))return fail('Missing code section');
      const c=new Reader(byId.get(10)),bodies=[];
      for(let n=c.u32();n;n--)bodies.push(c.take(c.u32())); c.end();
      if(bodies.length!==functions.count)return fail('Function count mismatch');
      const globalIndex=importedGlobals+globalVector.count;
      const insertion=concat(Uint8Array.of(0x23),u32(globalIndex),Uint8Array.of(0x94));
      const groups=new Map();
      for(const site of profile.sites) {
        const index=site.functionIndex-importedFunctions,body=bodies[index];
        if(!Number.isInteger(index)||!body||body.length!==site.bodySize) return fail('Camera function mismatch');
        if(!Number.isInteger(site.offset)||site.offset<=0||site.offset>=body.length||
          !Number.isInteger(site.guardOffset)||site.guardOffset<0||!site.guard?.length||
          site.guardOffset+site.guard.length>body.length||
          site.offset<site.guardOffset||site.offset>=site.guardOffset+site.guard.length||
          !site.guard.every((v,j)=>body[site.guardOffset+j]===v)) return fail('Camera instruction guard mismatch');
        if(!groups.has(index))groups.set(index,[]); groups.get(index).push(site.offset);
      }
      for(const [index,offsets] of groups) {
        offsets.sort((a,b)=>a-b);
        if(new Set(offsets).size!==offsets.length)return fail('Duplicate camera site');
        const body=bodies[index],parts=[]; let at=0;
        for(const offset of offsets) { parts.push(body.subarray(at,offset),insertion); at=offset; }
        parts.push(body.subarray(at)); bodies[index]=concat(...parts);
      }
      const name=new TextEncoder().encode(EXPORT_NAME);
      const replacements=new Map([
        [6,concat(u32(globalVector.count+1),globalVector.entries,Uint8Array.of(0x7d,1,0x43,0,0,0x80,0x3f,0x0b))],
        [7,concat(u32(exportVector.count+1),exportVector.entries,u32(name.length),name,Uint8Array.of(3),u32(globalIndex))],
        [10,concat(u32(bodies.length),...bodies.map(body=>concat(u32(body.length),body)))]
      ]);
      const parts=[original.subarray(0,8)],emitted=new Set();
      for(const s of sections) {
        if(s.id)for(const id of replacements.keys())if(!byId.has(id)&&!emitted.has(id)&&rank(id)<rank(s.id)) { parts.push(section(id,replacements.get(id))); emitted.add(id); }
        parts.push(section(s.id,replacements.get(s.id)||s.payload)); if(s.id)emitted.add(s.id);
      }
      for(const [id,payload] of replacements)if(!emitted.has(id))parts.push(section(id,payload));
      const bytes=concat(...parts);
      if(!WebAssembly.validate(bytes))return fail('Patched WASM does not validate');
      return {patched:true,reason:'World camera scale patched',bytes,exportName:EXPORT_NAME,globalIndex};
    } catch(error) { return fail(error.message); }
  }
  async function prepareWasm(input, crypto=globalThis.crypto) {
    let bytes;
    try {
      // Snapshot once so verification and patching examine the same bytes.
      bytes=Uint8Array.from(bytesOf(input));
      const candidates=PROFILES.filter(profile=>bytes.length===profile.byteLength);
      if(!candidates.length)return {patched:false,reason:'Unsupported client size',bytes};
      if(!crypto?.subtle) return {patched:false,reason:'SHA-256 is unavailable',bytes};
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      const sha256=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
      const profile=candidates.find(profile=>sha256===profile.sha256);
      if(!profile)return {patched:false,reason:'Unsupported client fingerprint',bytes,sha256};
      return {...patchWasm(bytes,profile),sha256};
    } catch(error) { return {patched:false,reason:error.message,bytes:bytes||input}; }
  }
  return {EXPORT_NAME,PROFILE,CURRENT_PROFILE,PROFILES,patchWasm,prepareWasm};
});


/* SPDX-License-Identifier: MIT
 * Optional WASM preparation with an unchanged-byte fallback.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DiepFovLoader = api;
})(globalThis, function () {
  'use strict';

  function install(callbacks = {}, env = globalThis) {
    const wasm = env.WebAssembly;
    if (!wasm || typeof wasm.instantiate !== 'function') throw new Error('WebAssembly.instantiate is unavailable');
    const originalInstantiate = wasm.instantiate;
    const originalStreaming = wasm.instantiateStreaming;
    let active = true;

    function report(error, token) {
      if (!active) return;
      try {
        const callback = callbacks.onError;
        if (typeof callback === 'function') Promise.resolve(callback(error, token)).catch(() => {});
      } catch {}
    }

    function observe(result, token) {
      if (!active) return result;
      try {
        const callback = callbacks.onInstance;
        if (typeof callback === 'function') {
          Promise.resolve(callback(result?.instance || result, token)).catch(error => report(error, token));
        }
      } catch (error) { report(error, token); }
      return result;
    }

    function copyBytes(source) {
      if (ArrayBuffer.isView(source)) {
        return new Uint8Array(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
      }
      if (Object.prototype.toString.call(source) === '[object ArrayBuffer]') {
        return new Uint8Array(new Uint8Array(source));
      }
      return null;
    }

    async function prepare(original, token) {
      if (!active) return original;
      try {
        const callback = callbacks.prepare;
        if (typeof callback !== 'function') return original;
        // A preparer may mutate its input; retain a separate pristine fallback.
        const result = await callback(original.slice(), token);
        if (!active || result == null) return original;
        if (Object.prototype.toString.call(result) !== '[object Uint8Array]') {
          throw new TypeError('WASM prepare must return Uint8Array or null');
        }
        return new Uint8Array(result);
      } catch (error) {
        report(error, token);
        return original;
      }
    }

    async function instantiateBytes(original, args, receiver, token) {
      const prepared = await prepare(original, token);
      const changed = prepared.length !== original.length || prepared.some((byte, index) => byte !== original[index]);
      const nativeArgs = args.slice();
      nativeArgs[0] = prepared;
      let result;
      try {
        result = await Reflect.apply(originalInstantiate, receiver, nativeArgs);
      } catch (error) {
        // Compile failure cannot have run a start function. Never retry a link or
        // runtime failure, which might have involved imported state or side effects.
        if (!changed || !(error instanceof wasm.CompileError)) throw error;
        report(error, token);
        nativeArgs[0] = original;
        result = await Reflect.apply(originalInstantiate, receiver, nativeArgs);
      }
      return observe(result, token);
    }

    function instantiate(...args) {
      if (!active) return Reflect.apply(originalInstantiate, this, args);
      const token = {};
      let bytes;
      try { bytes = copyBytes(args[0]); }
      catch (error) { report(error, token); }
      if (bytes) return instantiateBytes(bytes, args, this, token);
      // Modules and invalid non-buffer arguments retain native handling.
      const result = Reflect.apply(originalInstantiate, this, args);
      return Promise.resolve(result).then(value => observe(value, token));
    }

    async function instantiateStreaming(...args) {
      if (!active) return Reflect.apply(originalStreaming, this, args);
      const token = {};
      let response;
      try { response = await args[0]; }
      catch (error) {
        // Native code owns source-promise rejection behavior.
        return Reflect.apply(originalStreaming, this, args);
      }
      const nativeArgs = args.slice();
      nativeArgs[0] = response;
      let bytes;
      let useNative = false;
      try {
        const mime = response.headers.get('Content-Type');
        if (!response.ok || typeof mime !== 'string' || mime.trim().toLowerCase() !== 'application/wasm') {
          useNative = true;
        } else {
          bytes = new Uint8Array(await response.clone().arrayBuffer());
        }
      } catch (error) {
        report(error, token);
        useNative = true;
      }
      if (useNative) {
        return Promise.resolve(Reflect.apply(originalStreaming, this, nativeArgs)).then(value => observe(value, token));
      }
      return instantiateBytes(bytes, nativeArgs, this, token);
    }

    wasm.instantiate = instantiate;
    try {
      if (typeof originalStreaming === 'function') wasm.instantiateStreaming = instantiateStreaming;
    } catch (error) {
      if (wasm.instantiate === instantiate) wasm.instantiate = originalInstantiate;
      active = false;
      throw error;
    }
    return {
      uninstall() {
        active = false;
        if (wasm.instantiate === instantiate) wasm.instantiate = originalInstantiate;
        if (wasm.instantiateStreaming === instantiateStreaming) wasm.instantiateStreaming = originalStreaming;
      }
    };
  }
  return {install};
});


(function (root, factory) {
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.DiepFovController=api;
})(globalThis,function () {
  'use strict';
  function create() {
    let handle=null,enabled=false,multiplier=1,destroyed=false;
    let state='waiting',message='Waiting for game WebAssembly. Reload if the game already loaded.';
    const listeners=new Set();
    const getStatus=()=>({state,message,enabled,multiplier,scale:enabled?1/multiplier:1});
    function notify() { for(const fn of listeners)try { fn(getStatus()); } catch {} }
    function apply() {
      try {
        if(handle)handle.value=enabled?1/multiplier:1;
        if(handle) { state='ready'; message=enabled?'Camera zoom active. J restores normal zoom.':'Ready. Enable to adjust the camera.'; }
      } catch(error) { enabled=false;state='error';message=`Camera control failed: ${error.message}`; }
      notify();
    }
    return {
      getStatus,
      onChange(fn) { listeners.add(fn); return ()=>listeners.delete(fn); },
      setStatus(next,text) { if(destroyed||handle)return; state=next; message=text; notify(); },
      setEnabled(value) { if(destroyed)return; enabled=!!value&&!!handle; apply(); },
      setMultiplier(value) {
        if(destroyed)return;
        if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new TypeError('View width must be a positive finite number');
        multiplier=Math.max(.1,Math.min(3,value)); apply();
      },
      attach(global) {
        if(destroyed)return;
        if(!global||typeof global.value!=='number')throw new TypeError('Missing camera multiplier');
        if(handle&&handle!==global)handle.value=1;
        handle=global; enabled=false; apply();
      },
      destroy() { if(destroyed)return; enabled=false; apply(); destroyed=true; listeners.clear(); handle=null; }
    };
  }
  return {create};
});


/* UI and input controls only. The supplied controller owns all FOV/memory behavior. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DiepFovControls = api;
})(globalThis, function (root) {
  'use strict';
  const STORAGE_KEY = 'diep-fov-editor-controls-v1';
  const MIN = 0.1, MAX = 3, STEP = 1.1;
  const finiteMultiplier = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const clamp = value => Math.max(MIN, Math.min(MAX, value));

  function install(controller, cursor = null) {
    for (const method of ['setMultiplier', 'setEnabled', 'getStatus', 'onChange']) {
      if (typeof controller?.[method] !== 'function') throw new TypeError(`FOV controller requires ${method}()`);
    }
    const doc = root.document;
    if (!doc) throw new Error('FOV controls require a document');
    let host = null, shadow = null, destroyed = false, unsubscribe = null, panelVisible = true;
    let multiplier = 1, enabled = false, state = null, controlError = '';
    const removers = [];
    try {
      const saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.version === 1 && finiteMultiplier(saved.multiplier)) multiplier = clamp(saved.multiplier);
    } catch {}

    function persist() {
      try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify({version: 1, multiplier})); } catch {}
    }
    function listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      removers.push(() => target.removeEventListener(type, callback, options));
    }
    function refresh() {
      if (destroyed) return;
      try {
        state = controller.getStatus() || {};
        if (typeof state.enabled === 'boolean') enabled = state.enabled;
        if (finiteMultiplier(state.multiplier)) multiplier = clamp(state.multiplier);
      } catch (error) { controlError = `Controls error: ${error.message || error}`; }
      if (!shadow) return;
      shadow.getElementById('toggle').textContent = enabled ? 'Disable · J' : 'Enable · J';
      shadow.getElementById('toggle').setAttribute('aria-pressed', String(enabled));
      shadow.getElementById('multiplier').textContent = multiplier.toFixed(2) + '×';
      shadow.getElementById('decrease').disabled = multiplier <= MIN + 1e-9;
      shadow.getElementById('increase').disabled = multiplier >= MAX - 1e-9;
      const labels = {ready: 'Ready', waiting: 'Waiting', unsupported: 'Unsupported', disabled: 'Disabled', error: 'Error'};
      const label = labels[state?.state] || (enabled ? 'Waiting' : 'Disabled');
      shadow.getElementById('state').textContent = enabled || label === 'Disabled' ? label : `Disabled · ${label}`;
      shadow.getElementById('status').textContent = controlError || state?.message || (enabled ? 'Waiting for the game’s FOV state.' : 'Enable when the game is ready.');
    }
    function command(action) {
      controlError = '';
      try { action(); } catch (error) { controlError = `Controls error: ${error.message || error}`; }
      refresh();
    }
    function changeMultiplier(value) {
      if (!finiteMultiplier(value)) return;
      const next = clamp(value);
      command(() => controller.setMultiplier(next));
      persist();
    }
    function toggle() {
      command(() => controller.setEnabled(!enabled));
    }
    function setPanelVisible(value) {
      if (destroyed) return;
      panelVisible = !!value;
      if (host) {
        if (!panelVisible) shadow.activeElement?.blur();
        host.style.display = panelVisible ? '' : 'none';
      }
    }
    function eventPath(event) {
      return typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    }
    function isEditable(node) {
      if (!node || node === root || node === doc) return false;
      const tag = String(node.tagName || '').toLowerCase();
      return ['input', 'textarea', 'select'].includes(tag) || !!node.isContentEditable
        || node.getAttribute?.('role') === 'textbox';
    }
    function blocked(event, allowPanel = false) {
      const path = eventPath(event);
      if (!allowPanel && host && path.includes(host)) return true;
      if (path.some(isEditable) || isEditable(doc.activeElement)) return true;
      // Keep page dialogs and their keyboard shortcuts usable, including custom modal forms.
      try {
        const modal = doc.querySelector('dialog[open], [aria-modal="true"]:not([aria-hidden="true"]):not([hidden])');
        if (modal && (!modal.getClientRects || modal.getClientRects().length)) return true;
      } catch {}
      return false;
    }
    function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function onKey(event) {
      if (event.repeat || event.ctrlKey || event.metaKey) return;
      if (event.altKey && !event.shiftKey && (event.code === 'KeyH' || String(event.key || '').toLowerCase() === 'h')) {
        if (blocked(event, true)) return;
        consume(event); setPanelVisible(!panelVisible); return;
      }
      if (event.altKey || blocked(event)) return;
      if (event.code !== 'KeyJ' && String(event.key || '').toLowerCase() !== 'j') return;
      consume(event); toggle();
    }
    function onWheel(event) {
      if (!enabled || event.ctrlKey || event.metaKey || event.altKey || blocked(event)) return;
      const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0);
      if (!Number.isFinite(delta) || delta === 0) return;
      consume(event);
      // One multiplicative step per wheel event keeps line and pixel delta modes consistent.
      changeMultiplier(multiplier * (delta > 0 ? STEP : 1 / STEP));
    }
    function mount() {
      if (destroyed || host) return;
      host = doc.createElement('div');
      host.id = 'diep-fov-controls';
      host.style.cssText = 'position:fixed;right:14px;top:14px;z-index:2147483100';
      shadow = host.attachShadow({mode: 'open'});
      shadow.innerHTML = `<style>
        :host{all:initial;color-scheme:dark}*{box-sizing:border-box}section{width:248px;max-width:calc(100vw - 28px);padding:14px;border:1px solid #3c5064;border-radius:12px;background:#122033f5;color:#eef5ff;box-shadow:0 8px 28px #0004;font:12px/1.5 system-ui,sans-serif}h2{margin:0;font-size:15px}small{font-size:10px;font-weight:400;color:#acbdd2}p{margin:6px 0;color:#b6c9de}.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}button{font:inherit;color:inherit;background:#263d57;border:1px solid #4b647e;border-radius:6px;padding:6px 9px;cursor:pointer}button:hover{background:#355372}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid #6ee4dc;outline-offset:2px}#toggle{flex:1;background:#245c59}output{min-width:70px;text-align:center;font-size:20px;font-variant-numeric:tabular-nums}#state{margin-top:12px;color:#87e0d7;font-weight:600}#status{overflow-wrap:anywhere;min-height:36px}.hint{font-size:11px;color:#95acc5;margin-bottom:0}
        </style><section aria-label="FOV editor controls">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h2>FOV editor <small>experimental</small></h2><button id="hide" type="button" title="Hide panel · Alt+H shows it again" aria-label="Hide FOV panel (Alt+H to show)">Hide</button></div>
        <div class="row"><button id="toggle" type="button" aria-pressed="false">Enable · J</button><button id="reset" type="button">Reset 1×</button></div>
        <div class="row"><button id="decrease" type="button" aria-label="Decrease visible width">−</button><output id="multiplier" aria-label="View width multiplier">1.00×</output><button id="increase" type="button" aria-label="Increase visible width">+</button></div>
        <p>View width · relative to normal camera</p>
        <div id="state" role="status"></div><p id="status"></p>
        <p class="hint">J toggles zoom. Wheel or Shift+wheel adjusts. Alt+H hides or shows this panel. Red box: normal FOV reference. Disabling restores normal zoom.</p>
        </section>`;
      (doc.documentElement || doc.body).appendChild(host);
      if (cursor) {
        const section = shadow.querySelector('section');
        section.style.maxHeight = 'calc(100vh - 28px)';
        section.style.overflowY = 'auto';
        cursor.mountControls(section);
      }
      setPanelVisible(panelVisible);
      listen(shadow.getElementById('hide'), 'click', () => setPanelVisible(false));
      listen(shadow.getElementById('toggle'), 'click', toggle);
      listen(shadow.getElementById('reset'), 'click', () => changeMultiplier(1));
      listen(shadow.getElementById('decrease'), 'click', () => changeMultiplier(multiplier / STEP));
      listen(shadow.getElementById('increase'), 'click', () => changeMultiplier(multiplier * STEP));
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'wheel', 'contextmenu']) {
        listen(host, type, event => event.stopPropagation());
      }
      refresh();
    }
    const initialMultiplier = multiplier;
    unsubscribe = controller.onChange(refresh);
    // Reloading always starts disabled; a saved zoom level is only a preference.
    command(() => { controller.setEnabled(false); controller.setMultiplier(initialMultiplier); });
    listen(root, 'keydown', onKey, true);
    listen(root, 'wheel', onWheel, {capture: true, passive: false});
    if (doc.readyState === 'loading') listen(doc, 'DOMContentLoaded', mount, {once: true});
    else mount();
    return {
      get element() { return host; },
      get panelVisible() { return panelVisible; },
      setPanelVisible,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
        removers.splice(0).reverse().forEach(remove => remove());
        try { controller.setEnabled(false); } catch {}
        host?.remove();
      }
    };
  }
  return {install};
});


/* Project the native viewport into the adjusted camera, in CSS pixels. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepFovOutline = api;
})(globalThis, function (root) {
  'use strict';
  function bounds(rect, status) {
    const multiplier = status.enabled ? status.multiplier : 1;
    if (![rect.left, rect.top, rect.width, rect.height, multiplier].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0 || multiplier <= 0) return null;
    const width = rect.width / multiplier, height = rect.height / multiplier;
    return {left: (rect.width - width) / 2, top: (rect.height - height) / 2, width, height};
  }
  function install(controller) {
    const doc = root.document;
    let host = null, box = null, canvas = null, pending = null, destroyed = false;
    let mutationObserver = null, resizeObserver = null;
    const removers = [];
    function schedule() {
      if (!destroyed && pending === null) pending = root.requestAnimationFrame(update);
    }
    function update() {
      pending = null;
      if (destroyed || !host) return;
      const nextCanvas = doc.getElementById('canvas');
      if (canvas !== nextCanvas) {
        if (canvas) resizeObserver?.unobserve(canvas);
        canvas = nextCanvas;
        if (canvas) resizeObserver?.observe(canvas);
      }
      const status = controller.getStatus();
      const rect = canvas?.getBoundingClientRect();
      const projected = rect && status.state === 'ready' ? bounds(rect, status) : null;
      host.style.display = projected ? 'block' : 'none';
      if (!projected) return;
      Object.assign(host.style, {left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px'});
      Object.assign(box.style, Object.fromEntries(Object.entries(projected).map(([key, value]) => [key, value + 'px'])));
    }
    function listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      removers.push(() => target.removeEventListener(type, callback, options));
    }
    function mount() {
      if (destroyed || host) return;
      host = doc.createElement('div');
      host.id = 'diep-fov-outline';
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial;position:fixed;display:none;overflow:hidden;pointer-events:none;z-index:2147483000';
      const shadow = host.attachShadow({mode: 'open'});
      shadow.innerHTML = '<style>:host{pointer-events:none!important}#box{position:absolute;box-sizing:border-box;border:2px solid #ff3030;pointer-events:none}span{position:absolute;top:3px;left:3px;padding:1px 5px;background:#300b0bd9;color:#ffb5b5;font:11px/1.5 system-ui,sans-serif;white-space:nowrap;pointer-events:none}</style><div id="box"><span>Normal FOV</span></div>';
      box = shadow.getElementById('box');
      (doc.documentElement || doc.body).appendChild(host);
      if (root.ResizeObserver) {
        resizeObserver = new root.ResizeObserver(schedule);
        resizeObserver.observe(doc.documentElement);
        if (doc.body) resizeObserver.observe(doc.body);
      }
      if (root.MutationObserver) {
        mutationObserver = new root.MutationObserver(records => {
          // Ignore our own style writes so observing page layout cannot create a loop.
          if (records.some(record => record.target !== host)) schedule();
        });
        mutationObserver.observe(doc.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden']});
      }
      schedule();
    }
    const unsubscribe = controller.onChange(schedule);
    listen(root, 'resize', schedule);
    listen(root, 'scroll', schedule, true);
    if (doc.readyState === 'loading') listen(doc, 'DOMContentLoaded', mount, {once: true});
    else mount();
    return {
      get element() { return host; },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (pending !== null) root.cancelAnimationFrame(pending);
        unsubscribe(); mutationObserver?.disconnect(); resizeObserver?.disconnect();
        removers.splice(0).forEach(remove => remove());
        host?.remove();
      }
    };
  }
  return {bounds, install};
});


(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DroneInference = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const EPS = 1e-8;
    const finite = Number.isFinite;
    const copyBox = box => box && ({ ...box });
    const validBox = box => !!box && [box.minX, box.minY, box.maxX, box.maxY].every(finite)
        && box.minX <= box.maxX && box.minY <= box.maxY;
    const boundsOf = points => ({
        minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)),
        maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y))
    });
    function intersectBoxes(a, b) {
        const box = {
            minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY),
            maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY)
        };
        return validBox(box) ? box : null;
    }
    function expandBox(box, distance) {
        return {
            minX: box.minX - distance, minY: box.minY - distance,
            maxX: box.maxX + distance, maxY: box.maxY + distance
        };
    }

    // Each constraint is a*x + b*y <= c. Position error is a disk around
    // the measured ray origin; the cone is an outer bound on its translation.
    function rayPlanes(ray, tangent, error) {
        const nx = -ray.dy, ny = ray.dx;
        return [[nx - tangent * ray.dx, ny - tangent * ray.dy],
            [-nx - tangent * ray.dx, -ny - tangent * ray.dy], [-ray.dx, -ray.dy]]
            .map(([a, b]) => ({ a, b, c: a * ray.x + b * ray.y + error * Math.hypot(a, b) }));
    }
    function satisfies(point, planes) {
        return planes.every(h => h.a * point.x + h.b * point.y <= h.c
            + EPS * (1 + Math.abs(h.c) + Math.abs(h.a * point.x) + Math.abs(h.b * point.y)));
    }
    function intersection(h, g) {
        const det = h.a * g.b - h.b * g.a;
        if (Math.abs(det) < 1e-10 * Math.hypot(h.a, h.b) * Math.hypot(g.a, g.b)) return null;
        const point = { x: (h.c * g.b - h.b * g.c) / det, y: (h.a * g.c - h.c * g.a) / det };
        return finite(point.x) && finite(point.y) ? point : null;
    }
    function bounded(planes) {
        const angles = planes.map(h => Math.atan2(h.b, h.a)).sort((a, b) => a - b);
        let maxGap = angles[0] + Math.PI * 2 - angles[angles.length - 1];
        for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
        return maxGap < Math.PI - 1e-10;
    }
    function uncertaintyPolygon(planes) {
        if (!bounded(planes)) return null;
        const vertices = [];
        for (let i = 0; i < planes.length; i++) {
            for (let j = i + 1; j < planes.length; j++) {
                const point = intersection(planes[i], planes[j]);
                if (point && satisfies(point, planes) && !vertices.some(p => Math.hypot(p.x - point.x, p.y - point.y) < 1e-6)) {
                    vertices.push(point);
                }
            }
        }
        if (!vertices.length) return null;
        const center = vertices.reduce((p, v) => ({ x: p.x + v.x / vertices.length, y: p.y + v.y / vertices.length }), { x: 0, y: 0 });
        return vertices.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
    }
    function fitLines(rays) {
        let a = 0, b = 0, d = 0, ex = 0, ey = 0;
        const maxWeight = Math.max(...rays.map(r => r.weight));
        for (const r of rays) {
            const nx = -r.dy, ny = r.dx, projection = nx * r.x + ny * r.y, w = r.weight / maxWeight;
            a += w * nx * nx; b += w * nx * ny; d += w * ny * ny;
            ex += w * nx * projection; ey += w * ny * projection;
        }
        const trace = a + d, gap = Math.hypot(a - d, 2 * b), high = (trace + gap) / 2;
        const conditionRatio = high > 0 ? Math.max(0, (trace - gap) / 2) / high : 0;
        const det = a * d - b * b;
        if (det <= 1e-12 * Math.max(1, trace * trace)) return { conditionRatio, point: null };
        return { conditionRatio, point: { x: (d * ex - b * ey) / det, y: (a * ey - b * ex) / det } };
    }

    /**
     * Estimate a common cursor from simultaneously observed, world-space rays.
     * A forward ray points toward the cursor; reverse points away from it.
     * These are geometric bounds conditional on the error limits and a single
     * shared target. They are not confidence probabilities. Unknown control
     * modes, stale headings, and camera errors must be rejected by the caller.
     */
    function estimateCursor(inputRays, options = {}) {
        const mode = options.mode ?? 'forward';
        const positionError = options.positionError ?? 8;
        const angularErrorDeg = options.angularErrorDeg ?? 3;
        const minRays = options.minRays ?? 3;
        const minInlierFraction = options.minInlierFraction ?? 0.7;
        const minConditionRatio = options.minConditionRatio ?? 0.003;
        const fail = (reason, extra = {}) => ({ ok: false, reason, mode, ...extra });
        if (!Array.isArray(inputRays)) return fail('invalid-rays');
        if (!['forward', 'reverse'].includes(mode) || !finite(positionError) || positionError < 0
            || !finite(angularErrorDeg) || angularErrorDeg < 0 || angularErrorDeg >= 45
            || !Number.isInteger(minRays) || minRays < 2
            || !finite(minInlierFraction) || minInlierFraction <= 0.5 || minInlierFraction > 1
            || !finite(minConditionRatio) || minConditionRatio < 0 || minConditionRatio >= 1) return fail('invalid-options');
        if (inputRays.length > 64) return fail('too-many-rays');
        const sign = mode === 'reverse' ? -1 : 1;
        const rays = inputRays.map((r, index) => {
            if (!r || ![r.x, r.y, r.dx, r.dy].every(finite)) return null;
            const norm = Math.hypot(r.dx, r.dy), weight = r.weight ?? 1;
            if (norm < EPS || !finite(weight) || weight <= 0) return null;
            return { x: r.x, y: r.y, dx: sign * r.dx / norm, dy: sign * r.dy / norm, weight, index };
        }).filter(Boolean);
        const totalRays = rays.length;
        if (totalRays < minRays) return fail('insufficient-rays', { totalRays });
        const required = Math.max(minRays, Math.ceil(totalRays * minInlierFraction));
        const tangent = Math.tan(angularErrorDeg * Math.PI / 180);
        const planesByRay = rays.map(r => rayPlanes(r, tangent, positionError));
        const allPlanes = planesByRay.flat();
        const candidates = [];
        const allFit = fitLines(rays);
        if (allFit.point) candidates.push(allFit.point);
        for (let i = 0; i < allPlanes.length; i++) {
            for (let j = i + 1; j < allPlanes.length; j++) {
                const point = intersection(allPlanes[i], allPlanes[j]);
                if (point) candidates.push(point);
            }
        }
        let bestCount = 0;
        const consensusSets = new Map();
        for (const point of candidates) {
            const indices = [];
            for (let i = 0; i < rays.length; i++) if (satisfies(point, planesByRay[i])) indices.push(i);
            if (indices.length < required || indices.length < bestCount) continue;
            if (indices.length > bestCount) { bestCount = indices.length; consensusSets.clear(); }
            consensusSets.set(indices.join(','), indices);
        }
        if (!bestCount) return fail(allFit.conditionRatio < minConditionRatio ? 'parallel-or-ill-conditioned' : 'no-consensus', { totalRays });
        // If two different maximal subsets remain possible, choosing one could
        // falsely exclude the true cursor. Ask the caller for a later sample.
        if (consensusSets.size > 1) return fail('ambiguous-consensus', { totalRays, inlierCount: bestCount });
        const indices = consensusSets.values().next().value;
        const inliers = indices.map(i => rays[i]);
        const fit = fitLines(inliers);
        if (!fit.point || fit.conditionRatio < minConditionRatio) return fail('parallel-or-ill-conditioned', { totalRays, conditionRatio: fit.conditionRatio });
        const planes = indices.flatMap(i => planesByRay[i]);
        const polygon = uncertaintyPolygon(planes);
        if (!polygon) {
            // The drawn centre lines can have a useful visual crossing even
            // when heading error leaves distance unbounded. This is explicitly
            // not an accepted observation and carries no finite error bounds.
            const crossing = !bounded(planes) && satisfies(fit.point, planes) ? {
                x: fit.point.x, y: fit.point.y, inlierCount: inliers.length,
                conditionRatio: fit.conditionRatio,
                rmsError: Math.sqrt(inliers.reduce((sum, r) => sum
                    + ((-r.dy) * (fit.point.x - r.x) + r.dx * (fit.point.y - r.y)) ** 2, 0) / inliers.length)
            } : null;
            return fail('unbounded-or-inconsistent-uncertainty', { totalRays, conditionRatio: fit.conditionRatio, crossing });
        }
        const point = satisfies(fit.point, planes) ? fit.point : polygon.reduce((p, v) => ({ x: p.x + v.x / polygon.length, y: p.y + v.y / polygon.length }), { x: 0, y: 0 });
        const residuals = inliers.map(r => (-r.dy) * (point.x - r.x) + r.dx * (point.y - r.y));
        return {
            ok: true, reason: 'fit', mode, x: point.x, y: point.y, bounds: boundsOf(polygon), polygon,
            totalRays, inlierCount: inliers.length, inlierIndices: inliers.map(r => r.index),
            rejectedIndices: rays.filter(r => !inliers.includes(r)).map(r => r.index),
            conditionRatio: fit.conditionRatio,
            rmsError: Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length),
            errorRadius: Math.max(...polygon.map(p => Math.hypot(p.x - point.x, p.y - point.y))),
            positionError, angularErrorDeg
        };
    }

    // The tank/camera center can be anywhere within one opponent viewport of
    // the cursor. Padding must cover any bound on tank-to-camera displacement.
    function boxFromCursor(estimate, viewHalfWidth, viewHalfHeight, padding = 0) {
        if (!estimate?.ok || !validBox(estimate.bounds)
            || ![viewHalfWidth, viewHalfHeight, padding].every(finite)
            || viewHalfWidth <= 0 || viewHalfHeight <= 0 || padding < 0) return null;
        const b = estimate.bounds;
        return {
            minX: b.minX - viewHalfWidth - padding, maxX: b.maxX + viewHalfWidth + padding,
            minY: b.minY - viewHalfHeight - padding, maxY: b.maxY + viewHalfHeight + padding
        };
    }

    /**
     * F_n = (F_(n-1) expanded by maxSpeed * dt) intersect observation_n.
     * Square expansion is an outer bound on a circular speed limit: its
     * corners are deliberately loose. Supply performance.now()/1000 or another
     * monotonic clock, in seconds. No maximum dt clamp hides elapsed movement.
     */
    class TemporalRegion {
        constructor({ maxSpeed = 0, expireAfterSeconds = 3 } = {}) {
            if (!finite(maxSpeed) || maxSpeed < 0 || !finite(expireAfterSeconds) || expireAfterSeconds <= 0) {
                throw new TypeError('maxSpeed must be nonnegative and expiration must be positive.');
            }
            this.maxSpeed = maxSpeed;
            this.expireAfterSeconds = expireAfterSeconds;
            this.reset('empty');
        }
        reset(reason = 'reset') {
            this.box = null;
            this.observedAt = null;
            this.lastTime = null;
            this.status = reason;
            return { status: reason, box: null, ageSeconds: null };
        }
        _timeError(timeSeconds) {
            if (!finite(timeSeconds)) return 'invalid-time';
            if (this.lastTime !== null && timeSeconds < this.lastTime) return 'non-monotonic-time';
            return null;
        }
        predict(timeSeconds) {
            const error = this._timeError(timeSeconds);
            if (error) return { status: error, box: null, ageSeconds: null };
            this.lastTime = timeSeconds;
            if (!this.box) return { status: this.status, box: null, ageSeconds: null };
            const ageSeconds = timeSeconds - this.observedAt;
            if (ageSeconds >= this.expireAfterSeconds) {
                this.box = null;
                this.observedAt = null;
                this.status = 'expired';
                return { status: 'expired', box: null, ageSeconds };
            }
            return { status: ageSeconds === 0 ? this.status : 'predicted', box: expandBox(this.box, this.maxSpeed * ageSeconds), ageSeconds };
        }
        observe(observation, timeSeconds) {
            const error = this._timeError(timeSeconds);
            if (error) return { status: error, box: null, ageSeconds: null };
            if (!validBox(observation)) return { status: 'invalid-observation', box: null, ageSeconds: null };
            const prior = this.predict(timeSeconds);
            const overlap = prior.box && intersectBoxes(prior.box, observation);
            const status = prior.box ? (overlap ? 'updated' : 'contradiction-reset')
                : (prior.status === 'expired' ? 'reacquired' : 'initialized');
            this.box = copyBox(overlap || observation);
            this.observedAt = timeSeconds;
            this.status = status;
            return { status, box: copyBox(this.box), ageSeconds: 0, previousPrediction: copyBox(prior.box) };
        }
    }

    return { estimateCursor, boxFromCursor, TemporalRegion };
});


/* Canvas observation only. This module never changes draw arguments or styles. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DroneCapture = api;
})(globalThis, function () {
  'use strict';
  function point(ctx, x, y) {
    const m = ctx.getTransform();
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
  function triangle(vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 64
      || vertices.some(v => !v || !Number.isFinite(v.x) || !Number.isFinite(v.y))) return null;
    // The live renderer inserts extra points on straight polygon edges. Collapse
    // those points without reordering the corners used to recover the heading.
    const span = Math.max(Math.max(...vertices.map(v => v.x)) - Math.min(...vertices.map(v => v.x)),
      Math.max(...vertices.map(v => v.y)) - Math.min(...vertices.map(v => v.y)));
    const epsilon = Math.max(0.0001, span * 0.00001);
    const p = vertices.filter((v, i) => !i || Math.hypot(v.x - vertices[i - 1].x, v.y - vertices[i - 1].y) > epsilon);
    if (p.length > 1 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) <= epsilon) p.pop();
    let changed = true;
    while (changed && p.length > 3) {
      changed = false;
      for (let i = 0; i < p.length; i++) {
        const before = p[(i + p.length - 1) % p.length], after = p[(i + 1) % p.length], v = p[i];
        const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy);
        const along = length ? ((v.x - before.x) * dx + (v.y - before.y) * dy) / length : -Infinity;
        const across = length ? Math.abs((v.x - before.x) * dy - (v.y - before.y) * dx) / length : Infinity;
        if (across <= epsilon && along >= -epsilon && along <= length + epsilon) {
          p.splice(i, 1); changed = true; break;
        }
      }
    }
    if (p.length !== 3) return null;
    const sides = p.map((v, i) => Math.hypot(v.x - p[(i + 1) % 3].x, v.y - p[(i + 1) % 3].y));
    if (Math.min(...sides) < 2 || Math.max(...sides) / Math.min(...sides) > 1.12) return null;
    const x = p.reduce((sum, v) => sum + v.x, 0) / 3;
    const y = p.reduce((sum, v) => sum + v.y, 0) / 3;
    return { x, y, vertices: p, radius: Math.hypot(p[0].x - x, p[0].y - y) };
  }
  function install(getCanvas, prototype = CanvasRenderingContext2D.prototype, { resetOnFrameStart = false } = {}) {
    const states = new WeakMap(), restorers = [];
    let samples = [], lastError = null, frameId = 0, active = true;
    const stats = { canvasCalls: 0, fills: 0, accepted: 0, rejectedPaths: 0 };
    function hook(name, observe) {
      const original = prototype[name];
      if (typeof original !== 'function') return;
      const wrapped = function (...args) {
        if (active && this.canvas === getCanvas()) {
          stats.canvasCalls++;
          try { observe(this, args); } catch (error) { lastError = String(error); }
        }
        return Reflect.apply(original, this, args);
      };
      prototype[name] = wrapped;
      restorers.push(() => { if (prototype[name] === wrapped) prototype[name] = original; });
    }
    if (resetOnFrameStart) {
      function fullCanvas(ctx, args, clearing) {
        if (args.length < 4 || (!clearing && ctx.globalAlpha < 0.99)) return;
        const m = ctx.getTransform();
        if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) return;
        const a = point(ctx, args[0], args[1]), b = point(ctx, args[0] + args[2], args[1] + args[3]);
        if (Math.min(a.x, b.x) <= 1 && Math.min(a.y, b.y) <= 1
          && Math.max(a.x, b.x) >= ctx.canvas.width - 1 && Math.max(a.y, b.y) >= ctx.canvas.height - 1) {
          samples = []; frameId++;
        }
      }
      hook('clearRect', (ctx, args) => fullCanvas(ctx, args, true));
      hook('fillRect', (ctx, args) => fullCanvas(ctx, args, false));
    }
    function finishSubpath(state) {
      const current = state.current;
      if (current && (current.invalid || current.points.length > 1)) {
        if (state.paths.length < 32) state.paths.push(current);
        else state.overflow = true;
      }
      state.current = null;
    }
    function appendPoint(state, p) {
      if (!state.current) state.current = { points: [], invalid: false };
      if (state.current.invalid) return;
      if (state.current.points.length >= 64) state.current.invalid = true;
      else state.current.points.push(p);
    }
    hook('beginPath', ctx => states.set(ctx, { paths: [], current: null, overflow: false }));
    hook('moveTo', (ctx, a) => {
      const s = states.get(ctx);
      if (!s) return;
      finishSubpath(s);
      appendPoint(s, point(ctx, a[0], a[1]));
    });
    hook('lineTo', (ctx, a) => {
      const s = states.get(ctx);
      if (s) appendPoint(s, point(ctx, a[0], a[1]));
    });
    hook('closePath', ctx => {
      const s = states.get(ctx), first = s?.current?.points[0];
      if (!s || !first) return;
      finishSubpath(s);
      // Canvas closes the shape and leaves a new current subpath at its start.
      // The game subsequently calls moveTo(0, 0); that lone point is not a shape.
      s.current = { points: [first], invalid: false };
    });
    for (const method of ['arc', 'arcTo', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo']) {
      hook(method, ctx => {
        const s = states.get(ctx);
        if (s) {
          if (!s.current) s.current = { points: [], invalid: true };
          else s.current.invalid = true;
        }
      });
    }
    for (const method of ['rect', 'roundRect']) {
      hook(method, ctx => {
        const s = states.get(ctx);
        if (s) { finishSubpath(s); s.current = { points: [], invalid: true }; }
      });
    }
    hook('fill', (ctx, args) => {
      stats.fills++;
      // Opaque Path2D objects cannot be read by these hooks. Never reuse the current path for one.
      if (args[0] && typeof args[0] !== 'string') return;
      const s = states.get(ctx);
      if (!s || s.overflow || ctx.globalAlpha < 0.5 || typeof ctx.fillStyle !== 'string') return;
      const paths = s.current ? [...s.paths, s.current] : s.paths;
      for (const path of paths) {
        if (!path.invalid && path.points.length < 3) continue;
        const t = path.invalid ? null : triangle(path.points);
        if (!t) { stats.rejectedPaths++; continue; }
        if (samples.length < 256) { samples.push({ ...t, color: ctx.fillStyle.toLowerCase() }); stats.accepted++; }
      }
    });
    return {
      drain() { const result = samples; samples = []; return result; },
      get frameId() { return frameId; },
      clear() { samples = []; },
      get error() { return lastError; },
      get stats() { return { ...stats }; },
      uninstall() { active = false; restorers.reverse().forEach(restore => restore()); samples = []; }
    };
  }
  function toRays(samples, toWorld, { color = '#f14e54', minRadius = 36, maxRadius = 52, headingVertex = 0 } = {}) {
    const rays = [];
    for (const sample of samples) {
      if (sample.color !== color.toLowerCase()) continue;
      const center = toWorld(sample), tip = toWorld(sample.vertices[headingVertex]);
      const dx = tip.x - center.x, dy = tip.y - center.y, r = Math.hypot(dx, dy);
      if (![center.x, center.y, r].every(Number.isFinite) || r < minRadius || r > maxRadius) continue;
      // The same triangle may be filled repeatedly (outline, body, effects).
      if (rays.some(ray => Math.hypot(ray.x - center.x, ray.y - center.y) < 3)) continue;
      rays.push({ x: center.x, y: center.y, dx: dx / r, dy: dy / r });
    }
    return rays.slice(0, 16);
  }
  function mapPointer(x, y, rect, scale) {
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return {
      x: Math.max(rect.left, Math.min(rect.left + rect.width, cx + (x - cx) / scale)),
      y: Math.max(rect.top, Math.min(rect.top + rect.height, cy + (y - cy) / scale))
    };
  }
  return { triangle, install, toRays, mapPointer };
});


/* Fits visible drone headings in canvas-local CSS pixels. No camera calibration is needed. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./inference.js') : root.DroneInference);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DroneCursorModel = api;
})(globalThis, function (inference) {
  'use strict';
  const finite = Number.isFinite;

  function normalizeColor(value) {
    if (typeof value !== 'string') return null;
    const color = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(color)) return color;
    if (/^#[0-9a-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(c => c + c).join('');
    if (/^#[0-9a-f]{8}$/.test(color)) return parseInt(color.slice(7), 16) > 0 ? color.slice(0, 7) : null;
    if (/^#[0-9a-f]{4}$/.test(color)) return color[4] !== '0'
      ? '#' + [...color.slice(1, 4)].map(c => c + c).join('') : null;
    const match = /^rgba?\(([^)]+)\)$/.exec(color);
    if (match) {
      const parts = match[1].trim().split(/[\s,/]+/);
      if (parts.length !== 3 && parts.length !== 4) return null;
      const parse = (part, percentScale) => {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part)) return NaN;
        return parseFloat(part) * (part.endsWith('%') ? percentScale : 1);
      };
      const channels = parts.slice(0, 3).map(p => parse(p, 2.55));
      const alpha = parts.length === 4 ? parse(parts[3], 0.01) : 1;
      if (!channels.every(finite) || !finite(alpha) || alpha <= 0) return null;
      return '#' + channels.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
    }
    return null;
  }
  const channelsOf = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  function saturated(color) {
    const channels = channelsOf(color);
    return Math.max(...channels) - Math.min(...channels) > 40;
  }
  function hue(color) {
    const [r, g, b] = channelsOf(color), high = Math.max(r, g, b), range = high - Math.min(r, g, b);
    if (!range) return 0;
    return ((high === r ? (g - b) / range : high === g ? (b - r) / range + 2 : (r - g) / range + 4) * 60 + 360) % 360;
  }
  function colorsMatch(a, b) {
    if (a === b) return true;
    const ac = channelsOf(a), bc = channelsOf(b), hueGap = Math.abs(hue(a) - hue(b));
    // A theme can change saturation/brightness without changing the team's hue.
    // The hue guard prevents pale colors from merging different teams.
    return Math.min(hueGap, 360 - hueGap) <= 24
      && Math.sqrt(ac.reduce((sum, v, i) => sum + (v - bc[i]) ** 2, 0) / 3) <= 80;
  }
  function rayToEdge(ray, width, height, mode = 'forward') {
    if (!ray || ![ray.x, ray.y, ray.dx, ray.dy, width, height].every(finite)
      || width <= 0 || height <= 0 || !['forward', 'reverse'].includes(mode)
      || ray.x < 0 || ray.x > width || ray.y < 0 || ray.y > height) return null;
    const norm = Math.hypot(ray.dx, ray.dy);
    if (!finite(norm) || norm < 1e-9) return null;
    const sign = mode === 'reverse' ? -1 : 1;
    const dx = sign * ray.dx / norm, dy = sign * ray.dy / norm;
    const tx = dx > 0 ? (width - ray.x) / dx : dx < 0 ? -ray.x / dx : Infinity;
    const ty = dy > 0 ? (height - ray.y) / dy : dy < 0 ? -ray.y / dy : Infinity;
    const distance = Math.min(tx, ty);
    return { x: Math.max(0, Math.min(width, ray.x + distance * dx)),
      y: Math.max(0, Math.min(height, ray.y + distance * dy)) };
  }
  function pairIntersections(rays, viewport) {
    const points = [];
    const maxDistance = 4 * Math.hypot(viewport.width, viewport.height);
    for (let i = 0; i < rays.length; i++) {
      for (let j = i + 1; j < rays.length; j++) {
        const a = rays[i], b = rays[j];
        const ax = a.dx, ay = a.dy, bx = b.dx, by = b.dy;
        const determinant = ax * by - ay * bx;
        // Allow early, shallow crossings for the provisional marker. Keep
        // numerical degeneracy and distant intersections out of the solver.
        if (Math.abs(determinant) < 1e-6) continue;
        const offsetX = b.x - a.x, offsetY = b.y - a.y;
        const t = (offsetX * by - offsetY * bx) / determinant;
        // A triangle defines an axis through its centre and front vertex.
        // The shared point may lie on either side of each individual drone.
        const x = a.x + t * ax, y = a.y + t * ay;
        if (![x, y].every(finite)
          || Math.hypot(x - viewport.width / 2, y - viewport.height / 2) > maxDistance) continue;
        points.push({ x, y, indices: [i, j], mode: 'lines' });
      }
    }
    return points;
  }
  function fitsForGroup(rays, intersections, positionError, angularErrorDeg, viewport) {
    const fits = [], previews = [], available = new Set(rays.map((_, i) => i));
    const inRange = point => point && [point.x, point.y].every(finite)
      && Math.hypot(point.x - viewport.width / 2, point.y - viewport.height / 2)
        <= 4 * Math.hypot(viewport.width, viewport.height);
    const tangent = Math.tan(angularErrorDeg * Math.PI / 180);
    const supports = (point, ray) => {
      const x = point.x - ray.x, y = point.y - ray.y;
      const along = Math.abs(x * ray.dx + y * ray.dy);
      return Math.abs(x * ray.dy - y * ray.dx)
        <= tangent * along + positionError * Math.hypot(1, tangent) + 1e-7;
    };
    while (available.size >= 2 && fits.length + previews.length < 4) {
      const byMembers = new Map();
      for (const point of intersections) {
        if (!point.indices.every(i => available.has(i))) continue;
        const indices = [...available].filter(i => supports(point, rays[i]));
        if (indices.length < 2) continue;
        const key = indices.join(',');
        if (!byMembers.has(key)) byMembers.set(key, { ...point, indices });
      }
      let candidates = [...byMembers.values()].sort((a, b) => b.indices.length - a.indices.length);
      // Several unrelated pairs can cross anywhere. A two-drone point is only
      // useful if its rays do not also support a different possible pairing.
      candidates = candidates.filter(candidate => candidate.indices.length > 2 || !candidates.some(other =>
        other !== candidate && other.indices.some(i => candidate.indices.includes(i))));
      const evaluated = candidates.slice(0, 32).map(candidate => {
        // Reuse the uncertainty solver by orienting each line toward this
        // candidate independently. This imposes no shared attract/repel mode.
        const oriented = candidate.indices.map(i => {
          const ray = rays[i];
          const sign = (candidate.x - ray.x) * ray.dx + (candidate.y - ray.y) * ray.dy < 0 ? -1 : 1;
          return { ...ray, dx: sign * ray.dx, dy: sign * ray.dy };
        });
        const fit = inference.estimateCursor(oriented, {
          mode: 'forward', positionError, angularErrorDeg, minRays: 2, minInlierFraction: 1,
          // Bunched drones can dilute the average angular diversity even when
          // two outer headings bound the target. Keep a numerical floor here;
          // the full error-cone intersection still has to be finite and bounded.
          minConditionRatio: 1e-8
        });
        if (!fit.ok) return inRange(fit.crossing) ? {
          ...fit.crossing, provisional: true, reason: 'unbounded-distance', mode: 'lines',
          totalRays: rays.length, inlierIndices: candidate.indices
        } : null;
        return { ...fit, mode: 'lines', tentative: fit.inlierCount === 2, totalRays: rays.length,
          inlierIndices: candidate.indices,
          rejectedIndices: rays.map((_, i) => i).filter(i => !candidate.indices.includes(i)) };
      }).filter(Boolean).sort((a, b) => b.inlierCount - a.inlierCount || a.rmsError - b.rmsError
        || b.conditionRatio - a.conditionRatio);
      if (!evaluated.length) break;
      // Preserve bounded observations before considering display-only guesses.
      let best = evaluated.find(fit => fit.ok);
      if (best) fits.push(best);
      else {
        best = evaluated[0];
        if (evaluated.some(other => other !== best && other.inlierCount === best.inlierCount
          && other.inlierIndices.some(i => best.inlierIndices.includes(i)))) break;
        previews.push(best);
      }
      best.inlierIndices.forEach(i => available.delete(i));
    }
    return { fits, previews };
  }


  function directionalLocatorFits(baseFit, rays, positionError, angularErrorDeg) {
    if (!baseFit?.ok || !Array.isArray(rays)) return [];

    const sourceIndices = Array.isArray(baseFit.inlierIndices)
      ? baseFit.inlierIndices.filter(i => Number.isInteger(i) && rays[i])
      : [];

    if (sourceIndices.length < 3) return [];
    const used = sourceIndices.map(i => rays[i]);

    // A real shared cursor may be globally "forward" or globally "reverse".
    // The important constraint is that individual drones are NOT independently
    // flipped. This is axis-independent, so it protects:
    //   player up / drones down
    //   player down / drones up
    //   player left / drones right
    //   player right / drones left
    const attempts = ['forward', 'reverse'].map(mode => {
      const fit = inference.estimateCursor(used, {
        mode,
        positionError,
        angularErrorDeg,
        minRays: Math.min(3, used.length),
        minInlierFraction: 1,
        minConditionRatio: 1e-8
      });

      if (!fit?.ok) return null;

      const mappedInliers = (fit.inlierIndices || [])
        .map(i => sourceIndices[i])
        .filter(Number.isInteger);

      return {
        ...fit,
        directionMode: mode,
        inlierIndices: mappedInliers,
        rejectedIndices: sourceIndices.filter(i => !mappedInliers.includes(i)),
        baseLineFit: baseFit
      };
    }).filter(Boolean);

    // If forward and reverse collapse to effectively the same finite location,
    // keep one copy. Otherwise preserve both and let continuity/ambiguity logic
    // decide later; never guess from the undirected fit.
    const unique = [];
    for (const fit of attempts) {
      const duplicate = unique.some(other =>
        Math.hypot(other.x - fit.x, other.y - fit.y) <= 1
        && Math.abs((other.errorRadius ?? 0) - (fit.errorRadius ?? 0)) <= 1
      );
      if (!duplicate) unique.push(fit);
    }

    return unique;
  }


  function locatorQuality(fit, rays, viewport, config = {}) {
    if (!fit?.ok || !Array.isArray(rays) || !viewport) {
      return { ok: false, reason: 'invalid-fit' };
    }

    const indices = Array.isArray(fit.inlierIndices)
      ? fit.inlierIndices.filter(i => Number.isInteger(i) && rays[i])
      : [];

    const used = indices.map(i => rays[i]);
    const minRays = config.locatorMinRays ?? 3;
    const minConditionRatio = config.locatorMinConditionRatio ?? 0.0005;
    const minAngularSpreadDeg = config.locatorMinAngularSpreadDeg ?? 2.0;
    const maxLeverage = config.locatorMaxLeverage ?? 18;
    const maxErrorRadiusRatio = config.locatorMaxErrorRadiusRatio ?? 0.75;
    const maxRmsError = config.locatorMaxRmsError ?? 6;
    const minDirectionalCoherence = config.locatorMinDirectionalCoherence ?? 0.8;

    if (used.length < minRays) {
      return { ok: false, reason: 'too-few-inliers', inlierCount: used.length };
    }

    const centroid = used.reduce((p, r) => ({
      x: p.x + r.x / used.length,
      y: p.y + r.y / used.length
    }), { x: 0, y: 0 });

    let baseline = 0;
    let maxAngularSpread = 0;

    for (let i = 0; i < used.length; i++) {
      for (let j = i + 1; j < used.length; j++) {
        baseline = Math.max(
          baseline,
          Math.hypot(used[i].x - used[j].x, used[i].y - used[j].y)
        );

        const dot = Math.max(-1, Math.min(1,
          used[i].dx * used[j].dx + used[i].dy * used[j].dy
        ));

        // Orientation of a full line: anti-parallel is equivalent to parallel.
        maxAngularSpread = Math.max(maxAngularSpread, Math.acos(Math.abs(dot)));
      }
    }

    const angularSpreadDeg = maxAngularSpread * 180 / Math.PI;
    const cursorDistance = Math.hypot(fit.x - centroid.x, fit.y - centroid.y);
    const leverage = cursorDistance / Math.max(1, baseline);
    const viewportDiagonal = Math.hypot(viewport.width, viewport.height);
    const errorRadiusRatio = Number.isFinite(fit.errorRadius) && viewportDiagonal > 0
      ? fit.errorRadius / viewportDiagonal
      : Infinity;

    const conditionRatio = Number.isFinite(fit.conditionRatio) ? fit.conditionRatio : 0;
    const rmsError = Number.isFinite(fit.rmsError) ? fit.rmsError : Infinity;

    let forwardVotes = 0, reverseVotes = 0;
    for (const ray of used) {
      const dot = (fit.x - ray.x) * ray.dx + (fit.y - ray.y) * ray.dy;
      if (dot >= 0) forwardVotes++;
      else reverseVotes++;
    }
    const directionalCoherence = used.length
      ? Math.max(forwardVotes, reverseVotes) / used.length
      : 0;
    const inferredDirectionMode = forwardVotes >= reverseVotes ? 'forward' : 'reverse';

    let reason = 'good';
    if (directionalCoherence < minDirectionalCoherence) reason = 'mixed-drone-direction';
    else if (conditionRatio < minConditionRatio) reason = 'weak-condition';
    else if (angularSpreadDeg < minAngularSpreadDeg) reason = 'rays-too-parallel';
    else if (leverage > maxLeverage) reason = 'cursor-too-far-for-baseline';
    else if (errorRadiusRatio > maxErrorRadiusRatio) reason = 'uncertainty-too-large';
    else if (rmsError > maxRmsError) reason = 'residual-too-large';

    return {
      ok: reason === 'good',
      reason,
      inlierCount: used.length,
      conditionRatio,
      angularSpreadDeg,
      baseline,
      cursorDistance,
      leverage,
      errorRadiusRatio,
      rmsError,
      directionalCoherence,
      inferredDirectionMode,
      directionMode: fit.directionMode ?? inferredDirectionMode
    };
  }

  function analyze(samples, viewport, config = {}) {
    const empty = reason => ({ groups: [], colors: [], reason });
    if (!viewport || ![viewport.width, viewport.height, viewport.pixelWidth, viewport.pixelHeight]
      .every(value => finite(value) && value > 0)) return empty('invalid-viewport');
    if (!config || typeof config !== 'object') return empty('invalid-options');
    const selected = config.color === undefined || config.color === 'all' ? 'all' : normalizeColor(config.color);
    const headingVertex = config.headingVertex ?? 0, requestedMode = config.mode ?? 'lines';
    // Retain old saved values as aliases; all cursor fits now use full lines.
    const mode = 'lines';
    const minRadius = config.minRadius ?? 2, maxRadius = config.maxRadius ?? 70;
    const positionError = config.positionError ?? 2, angularErrorDeg = config.angularErrorDeg ?? 3;
    if (!selected || ![0, 1, 2].includes(headingVertex) || !['lines', 'forward', 'reverse', 'both'].includes(requestedMode)
      || ![minRadius, maxRadius, positionError, angularErrorDeg].every(finite)
      || minRadius <= 0 || maxRadius < minRadius || positionError < 0
      || angularErrorDeg < 0 || angularErrorDeg >= 45) return empty('invalid-options');
    if (!Array.isArray(samples)) return empty('no-triangles');
    const sx = viewport.width / viewport.pixelWidth, sy = viewport.height / viewport.pixelHeight;
    const byColor = new Map();
    for (const sample of samples) {
      if (!sample || ![sample.x, sample.y].every(finite)
        || !Array.isArray(sample.vertices) || sample.vertices.length !== 3
        || !sample.vertices.every(p => p && [p.x, p.y].every(finite))) continue;
      const color = normalizeColor(sample.color);
      if (!color || !saturated(color)) continue;
      const x = sample.x * sx, y = sample.y * sy, tip = sample.vertices[headingVertex];
      const dx = tip.x * sx - x, dy = tip.y * sy - y, radius = Math.hypot(dx, dy);
      if (!finite(radius) || radius < minRadius || radius > maxRadius) continue;
      if (!byColor.has(color)) byColor.set(color, []);
      const members = byColor.get(color);
      // Repeated body fills and differently sized effects must not add extra votes.
      if (members.some(ray => Math.hypot(ray.x - x, ray.y - y)
        <= Math.max(1, radius * 0.35, ray.radius * 0.35))) continue;
      members.push({ x, y, dx: dx / radius, dy: dy / radius, radius });
    }
    const families = [];
    for (const [color, members] of [...byColor].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      let family = families.find(group => colorsMatch(group.color, color));
      if (!family) { family = { color, members: [], shades: [] }; families.push(family); }
      family.shades.push(color);
      for (const ray of members) {
        if (!family.members.some(existing => Math.hypot(existing.x - ray.x, existing.y - ray.y)
          <= Math.max(1, ray.radius * 0.35, existing.radius * 0.35))) family.members.push(ray);
      }
    }
    const entries = families.sort((a, b) => b.members.length - a.members.length || a.color.localeCompare(b.color));
    const colors = entries.map(group => group.color);
    const groups = entries.filter(group => selected === 'all' || group.shades.some(color => colorsMatch(selected, color)))
      .slice(0, 4).map(({ color, members }) => {
        const rays = members.slice(0, 32).map(({ x, y, dx, dy }) => ({ x, y, dx, dy }));
        const intersections = pairIntersections(rays, viewport, mode);
        const { fits, previews } = fitsForGroup(rays, intersections, positionError, angularErrorDeg, viewport);

        // Preserve the ordinary full-line fits for the cursor overlay.
        const decoratedFits = fits.map(fit => ({ ...fit }));

        // The player locator uses a stricter GLOBAL-direction refit. Every
        // inlier drone must share the same orientation (all forward or all
        // reverse). This is the important mirrored-solution protection.
        const locatorFits = fits.flatMap(baseFit =>
          directionalLocatorFits(baseFit, rays, positionError, angularErrorDeg)
        ).map(directed => {
          const quality = locatorQuality(directed, rays, viewport, config);
          return { ...directed, locatorQuality: quality, locatorOk: quality.ok };
        }).filter(fit => fit?.locatorOk);

        const fit = decoratedFits[0] || { ok: false, mode, totalRays: rays.length,
          reason: previews.length ? 'unbounded-distance' : rays.length < 2 ? 'insufficient-rays'
            : intersections.length ? 'ambiguous-consensus' : 'parallel-or-ill-conditioned' };

        return { color, rays, intersections, fit, fits: decoratedFits, locatorFits, previews };
      });
    return { groups, colors, reason: groups.some(group => group.fit.ok) ? 'fit'
      : groups.some(group => group.previews.length) ? 'crossing'
      : groups.some(group => group.rays.length >= 2) ? 'no-consensus'
      : colors.length ? 'insufficient-drones' : 'no-triangles' };
  }
  return { analyze, rayToEdge, pairIntersections, normalizeColor, colorsMatch, locatorQuality, directionalLocatorFits };
});


/* Read-only camera coordinates for the exact clients audited in research/. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepShadowCamera = api;
})(globalThis, function () {
  'use strict';
  // Each layout and codec is pinned to its independently audited client hash.
  const SHA256 = '7ac1a1659ee8514ded697b39a218811d6c7318f6f6ffa12b5fe1763633610668';
  const X = 492396, Y = 492428, SCALE = 492404;
  // Plain f32 world edges used by the arena shading path in this same binary.
  const ARENA = {left:515420, top:515424, right:515428, bottom:515432};
  const CURRENT_SHA256 = 'd95b0afa7892bb9581b96939a41a7e22cc0e7a40c8b2c70d4faede66d3183126';
  const CURRENT_CAMERA = {x:603724, y:603756, scale:603732};
  const CURRENT_ARENA = {left:569996, top:570000, right:570004, bottom:570008};
  const scratch = new DataView(new ArrayBuffer(4));

  function arenaBounds(buffer, addresses = ARENA) {
    if (buffer.byteLength < addresses.bottom + 4) return null;
    const view = new DataView(buffer);
    const bounds = Object.fromEntries(Object.entries(addresses).map(([side,address])=>[side,view.getFloat32(address,true)]));
    if (!Object.values(bounds).every(value=>Number.isFinite(value)&&Math.abs(value)<=1e7)
      || bounds.right-bounds.left<100 || bounds.bottom-bounds.top<100
      || bounds.right-bounds.left>1e6 || bounds.bottom-bounds.top>1e6) return null;
    return bounds;
  }

  function decode(word) {
    const e0 = word & 255, e1 = word >>> 8 & 255, e2 = word >>> 16 & 255, e3 = word >>> 24;
    const bits = (((e3 + 192) & 255) ^ 72)
      | ((((e0 + 49 * e3 - 38) & 255) ^ 90) << 8)
      | ((((e1 - 75 * e0 + 14) & 255) ^ 8) << 16)
      | ((((e2 + 63 * e1 + 98) & 255) ^ 75) << 24);
    scratch.setUint32(0, bits >>> 0, true);
    return scratch.getFloat32(0, true);
  }

  function decodeCurrent(word) {
    const e0 = word & 255, e1 = word >>> 8 & 255, e2 = word >>> 16 & 255, e3 = word >>> 24;
    const bits = (((e0 + 81) & 255)
      | (((e3 + 131 * e0 + 227) & 255) << 8)
      | (((e2 + 42 * e3 + 107) & 255) << 16)
      | (((e1 + 95 * e2 - 11) & 255) << 24)) ^ 0x964c929b;
    scratch.setUint32(0, bits >>> 0, true);
    return scratch.getFloat32(0, true);
  }

  function readCamera(instance, sha256) {
    if (sha256 !== SHA256 && sha256 !== CURRENT_SHA256) return { ok: false, reason: 'unsupported-client' };
    const current = sha256 === CURRENT_SHA256;
    const addresses = current ? CURRENT_CAMERA : {x:X, y:Y, scale:SCALE};
    const decoder = current ? decodeCurrent : decode;
    try {
      const memory = instance?.exports?.da;
      if (!(memory instanceof WebAssembly.Memory)) return { ok: false, reason: 'missing-memory' };
      // memory.grow can replace its ArrayBuffer; fetch the current buffer on each call.
      const buffer = memory.buffer;
      if (buffer.byteLength < addresses.y + 4) return { ok: false, reason: 'truncated-memory' };
      const view = new DataView(buffer);
      const x = decoder(view.getUint32(addresses.x, true));
      const y = decoder(view.getUint32(addresses.y, true));
      const scale = decoder(view.getUint32(addresses.scale, true));
      if (![x, y, scale].every(Number.isFinite)
        || Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || scale < 1e-4 || scale > 100) {
        return { ok: false, reason: 'invalid-camera' };
      }
      // Scale is backing pixels per world unit, already including the active zoom.
      // BackingX = canvas.width / 2 + (worldX - x) * scale; Y has the same sign.
      const arena = arenaBounds(buffer, current ? CURRENT_ARENA : ARENA);
      return { ok: true, x, y, scale, ...(arena ? {arenaBounds:arena} : {}) };
    } catch {
      return { ok: false, reason: 'unavailable-memory' };
    }
  }
  return { readCamera };
});


/* Short-lived motion predictions in a shared coordinate system. These are guesses,
 * not observations of entities outside the server's visible area. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DroneShadows = api;
})(globalThis, function () {
  'use strict';
  const finite = Number.isFinite;
  const MAX_TRACKS = 32, MISSING_GRACE = 0.08, MAX_UPDATE_GAP = 1;
  // Historical Diep research reports 10% drag per tick. The public clone uses
  // 40 ms ticks. This continuous approximation preserves momentum when steering;
  // it is not a copy of the current server's unknown simulation.
  const DRAG = -Math.log(0.9) / 0.04;
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const validBounds = b => b && [b.left, b.top, b.width, b.height].every(finite)
    && b.width > 0 && b.height > 0;
  const inside = (p, b) => {
    const epsilon = Math.max(b.width, b.height) * 1e-9;
    return p.x >= b.left - epsilon && p.x <= b.left + b.width + epsilon
      && p.y >= b.top - epsilon && p.y <= b.top + b.height + epsilon;
  };
  const length = v => Math.hypot(v.vx, v.vy);
  function arenaLimits(input) {
    if (!input || typeof input !== 'object') return {};
    const result = {};
    for (const side of ['left','right','top','bottom']) if (finite(input[side])) result[side]=input[side];
    if (result.left >= result.right || result.top >= result.bottom) return {};
    return result;
  }
  function constrainArena(track, arena) {
    // Limits describe real drone CENTRES, including any padding beyond the
    // painted arena. Preserve momentum, as in the reference positional clamp;
    // reversing an input still has to overcome outward velocity.
    if (finite(arena.left)) track.x=Math.max(arena.left,track.x);
    if (finite(arena.right)) track.x=Math.min(arena.right,track.x);
    if (finite(arena.top)) track.y=Math.max(arena.top,track.y);
    if (finite(arena.bottom)) track.y=Math.min(arena.bottom,track.y);
  }

  function nearOutwardBoundary(track, bounds) {
    if (!track.velocityKnown) return false;
    // Rendering can include a small area outside the reference FOV rectangle.
    if (!inside(track, bounds)) return true;
    if (length(track) < 1e-6) return false;
    // Allow roughly 120 ms of travel plus the body radius between the final
    // actual sample and an edge. Interior disappearance is not evidence of exit.
    const margin = Math.max(track.radius * 2, length(track) * 0.12);
    const { x, y, vx, vy } = track;
    const horizontal = y >= bounds.top - margin && y <= bounds.top + bounds.height + margin;
    const vertical = x >= bounds.left - margin && x <= bounds.left + bounds.width + margin;
    return (horizontal && ((Math.abs(x - bounds.left) <= margin && vx < -1e-6)
      || (Math.abs(x - bounds.left - bounds.width) <= margin && vx > 1e-6)))
      || (vertical && ((Math.abs(y - bounds.top) <= margin && vy < -1e-6)
      || (Math.abs(y - bounds.top - bounds.height) <= margin && vy > 1e-6)));
  }

  function advance(track, delta, pointer, steering, arena) {
    if (!track.velocityKnown || delta <= 0) return;
    const steps = Math.max(1, Math.ceil(delta / 0.01)), step = delta / steps;
    for (let i = 0; i < steps; i++) {
      const oldVx = track.vx, oldVy = track.vy;
      if (pointer && steering !== 'coast') {
        const px = pointer.x - track.x, py = pointer.y - track.y;
        const distance = Math.hypot(px, py), sign = steering === 'repel' ? -1 : 1;
        let targetVx = 0, targetVy = 0;
        if (distance > 1e-9) {
          // The nose points at the control target even while inertia carries
          // the drone sideways or in the opposite direction.
          track.dx = sign * px / distance; track.dy = sign * py / distance;
          targetVx = track.dx * track.cruiseSpeed; targetVy = track.dy * track.cruiseSpeed;
        }
        const response = -Math.expm1(-DRAG * step);
        track.vx += (targetVx - oldVx) * response;
        track.vy += (targetVy - oldVy) * response;
        track.x += targetVx * step + (oldVx - targetVx) * response / DRAG;
        track.y += targetVy * step + (oldVy - targetVy) * response / DRAG;
      } else {
        // No reliable offscreen AI target is available. Continue the observed
        // motion rather than inventing a return/orbit target.
        track.x += oldVx * step; track.y += oldVy * step;
      }
      constrainArena(track,arena);
    }
  }

  function measureVelocity(track, observation, elapsed, pointer, steering, arena) {
    // A returning observation is a new baseline. Its displacement over a hidden
    // interval is not an instantaneous velocity measurement.
    if (!track.wasObserved || elapsed > 0.25) {
      track.velocitySamples = []; track.speedSamples = [];
      track.vx = track.measuredVx; track.vy = track.measuredVy;
      return;
    }
    if (elapsed <= 1e-6) return;
    track.velocitySamples.push({vx:(observation.x-track.lastActualX)/elapsed,
      vy:(observation.y-track.lastActualY)/elapsed});
    if (track.velocitySamples.length > 5) track.velocitySamples.shift();
    // A single bad position creates a positive and a negative velocity spike.
    // Component medians suppress both without storing the spike as top speed.
    track.measuredVx = median(track.velocitySamples.map(p=>p.vx));
    track.measuredVy = median(track.velocitySamples.map(p=>p.vy));
    track.vx = track.measuredVx; track.vy = track.measuredVy;
    const wasKnown = track.velocityKnown;
    track.velocityKnown = true; track.observedSpeed = length(track);
    const controlled = pointer && steering !== 'coast';
    const nearTarget = controlled && Math.hypot(pointer.x-observation.x,pointer.y-observation.y)
      < Math.max(track.radius*4,track.cruiseSpeed/DRAG*2);
    const nearWall=Object.entries(arena).some(([side,value])=>Math.abs(
      observation[side==='left'||side==='right'?'x':'y']-value)<track.radius*.5);
    const dx=controlled?pointer.x-observation.x:0,dy=controlled?pointer.y-observation.y:0;
    const direction=steering==='repel'?-1:1;
    const alignment=controlled&&track.observedSpeed>1e-6?
      direction*(dx*track.measuredVx+dy*track.measuredVy)/(Math.hypot(dx,dy)*track.observedSpeed):1;
    // Turning/settling near the cursor measures current speed, not cruise speed.
    // Retain the travel-speed estimate so a later command can accelerate again.
    if (wasKnown && (nearTarget || nearWall || alignment<.96)) { track.speedSamples=[]; return; }
    track.speedSamples.push(track.observedSpeed);
    if (track.speedSamples.length > 3) track.speedSamples.shift();
    if (!wasKnown && track.observedSpeed > 0) track.cruiseSpeed = track.observedSpeed;
    if (track.speedSamples.length === 3) {
      const speed = median(track.speedSamples), spread = Math.max(...track.speedSamples)-Math.min(...track.speedSamples);
      // Keep the last moving estimate through a stop, but allow sustained slower
      // motion to correct an old high estimate, including a launch impulse.
      if (speed > track.radius * 0.01 && spread <= speed * 0.15) {
        const weight = track.cruiseSpeed > 0 ? 1-Math.exp(-elapsed/0.15) : 1;
        track.cruiseSpeed += (speed-track.cruiseSpeed)*weight;
      }
    }
  }

  function observationsOf(input) {
    if (!Array.isArray(input)) return [];
    const result = [];
    for (const p of input) {
      if (!p || ![p.x, p.y, p.radius].every(finite) || p.radius <= 0) continue;
      const norm = Math.hypot(p.dx, p.dy);
      if (!finite(norm) || norm < 1e-6) continue;
      // Repeated fills of the same body must not acquire separate tracks.
      if (result.some(other => Math.hypot(other.x - p.x, other.y - p.y) < p.radius * 0.35)) continue;
      result.push({ x: p.x, y: p.y, dx: p.dx / norm, dy: p.dy / norm,
        radius: p.radius, color: typeof p.color === 'string' ? p.color : '' });
      if (result.length === MAX_TRACKS) break;
    }
    return result;
  }

  class Tracker {
    constructor() { this.reset(); }
    reset() {
      this._tracks = [];
      this._time = null;
      this._nextId = 1;
      this._shadows = [];
    }
    get counts() {
      const observed = this._tracks.filter(track => track.observed).length;
      return { tracked: this._tracks.length, observed, missing: this._tracks.length - observed,
        shadows: this._shadows.length };
    }
    get tracks() {
      return this._tracks.map(track => ({ id: track.id, x: track.x, y: track.y, vx: track.vx, vy: track.vy,
        radius: track.radius, color: track.color, observed: track.observed,
        measuredVx: track.measuredVx, measuredVy: track.measuredVy,
        observedSpeed: track.observedSpeed, cruiseSpeed: track.cruiseSpeed,
        velocityKnown: track.velocityKnown, exitEligible: track.exitEligible,
        lastObservedAt: track.lastSeen, age: Math.max(0, (this._time ?? track.lastSeen) - track.lastSeen),
        shadow: this._shadows.some(shadow => shadow.id === track.id) }));
    }
    update(input, timeSeconds, options = {}) {
      const bounds = options?.bounds;
      if (!finite(timeSeconds) || !validBounds(bounds)) { this.reset(); return []; }
      let delta = this._time === null ? 0 : timeSeconds - this._time;
      if (delta < 0 || delta > MAX_UPDATE_GAP) { this.reset(); delta = 0; }
      this._time = timeSeconds;
      const observations = observationsOf(input);
      const maxAge = finite(options.maxAge) && options.maxAge > 0 ? options.maxAge : 15;
      const pointer = options.pointer && [options.pointer.x, options.pointer.y].every(finite) ? options.pointer : null;
      const steering = ['attract', 'repel'].includes(options.steering) ? options.steering : 'coast';
      const arena = arenaLimits(options.arena);
      this._tracks = this._tracks.filter(track => timeSeconds - track.lastSeen < maxAge);
      this._tracks.forEach(track => {
        track.wasObserved = track.observed;
        advance(track, delta, pointer, steering, arena); track.observed = false;
      });

      // Match visible continuations first. For a reentry, also consider how far
      // the real drone could have travelled from its last observation: a guessed
      // turn can be wrong without implying that the returning drone is new.
      const pairs = [];
      for (let i = 0; i < this._tracks.length; i++) {
        const track = this._tracks[i], missingAge = timeSeconds - track.lastSeen;
        for (let j = 0; j < observations.length; j++) {
          const observation = observations[j], distance = Math.hypot(track.x - observation.x, track.y - observation.y);
          if (Math.max(track.radius, observation.radius) > 1.35*Math.min(track.radius, observation.radius)) continue;
          const gate = 3 * Math.max(track.radius, observation.radius)
            + Math.min(12 * track.radius, length(track) * (0.12 + missingAge * 0.25));
          const lastDistance = Math.hypot(track.lastActualX-observation.x, track.lastActualY-observation.y);
          const reach = 3*Math.max(track.radius, observation.radius)
            + Math.max(track.cruiseSpeed, track.observedSpeed)*Math.min(1, missingAge);
          const reentry = !track.wasObserved && lastDistance <= reach;
          if (distance <= gate || reentry) pairs.push({ i, j,
            priority:track.wasObserved?0:distance<=gate?1:2,
            distance:distance<=gate?distance:lastDistance });
        }
      }
      pairs.sort((a, b) => a.priority-b.priority || a.distance - b.distance || a.i - b.i || a.j - b.j);
      const matchedTracks = new Set(), matchedObservations = new Set();
      for (const pair of pairs) {
        if (matchedTracks.has(pair.i) || matchedObservations.has(pair.j)) continue;
        matchedTracks.add(pair.i); matchedObservations.add(pair.j);
        const track = this._tracks[pair.i], observation = observations[pair.j];
        const elapsed = timeSeconds - track.lastSeen;
        measureVelocity(track, observation, elapsed, pointer, steering, arena);
        Object.assign(track, observation, { observed: true, lastSeen: timeSeconds,
          lastActualX: observation.x, lastActualY: observation.y });
        track.exitEligible = nearOutwardBoundary(track, bounds);
      }
      // A moving camera can carry the last actual position out of the viewport
      // even when the drone itself was stationary. Use the actual position so
      // an interior disappearance cannot become an exit merely by extrapolation.
      for (const track of this._tracks) {
        if (!track.observed && track.velocityKnown
          && !inside({x:track.lastActualX,y:track.lastActualY}, bounds)) track.exitEligible = true;
      }
      for (let j = 0; j < observations.length; j++) {
        if (matchedObservations.has(j)) continue;
        if (this._tracks.length >= MAX_TRACKS) {
          // Prefer currently visible drones over the oldest missing guess.
          const oldest = this._tracks.reduce((best, track, i) => !track.observed
            && (best < 0 || track.lastSeen < this._tracks[best].lastSeen) ? i : best, -1);
          if (oldest < 0) break;
          this._tracks.splice(oldest, 1);
        }
        const observation = observations[j];
        this._tracks.push({ ...observation, id: this._nextId++, vx: 0, vy: 0,
          measuredVx: 0, measuredVy: 0, observedSpeed: 0, cruiseSpeed: 0,
          velocitySamples: [], speedSamples: [],
          velocityKnown: false, observed: true, lastSeen: timeSeconds,
          lastActualX: observation.x, lastActualY: observation.y, exitEligible: false });
      }
      this._shadows = this._tracks.filter(track => !track.observed && track.exitEligible
        && timeSeconds - track.lastSeen >= MISSING_GRACE - 1e-9 && !inside(track, bounds)).map(track => {
        const speed = length(track);
        return { id: track.id, x: track.x, y: track.y, vx: track.vx, vy: track.vy,
          dx: track.dx, dy: track.dy,
          radius: track.radius, color: track.color, age: timeSeconds - track.lastSeen, speed };
      });
      return this._shadows.map(shadow => ({ ...shadow }));
    }
  }
  return { Tracker };
});


/* Arena centre limits from the painted floor, refined by real stopped drones. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepArenaLimits = api;
})(globalThis, function () {
  'use strict';
  const SIDES = {
    left: { axis: 'x', tangent: 'y', velocity: 'measuredVx', sign: -1, opposite: 'right' },
    right: { axis: 'x', tangent: 'y', velocity: 'measuredVx', sign: 1, opposite: 'left' },
    top: { axis: 'y', tangent: 'x', velocity: 'measuredVy', sign: -1, opposite: 'bottom' },
    bottom: { axis: 'y', tangent: 'x', velocity: 'measuredVy', sign: 1, opposite: 'top' }
  };
  const finite = Number.isFinite;
  const PADDING = 200, REFINEMENT_RANGE = 100, RECT_TOLERANCE = 0.5;
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const shared = (ids, tracks) => tracks.reduce((n, track) => n + (ids.has(track.id) ? 1 : 0), 0);
  function actuals(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set(), tracks = [];
    for (const track of input) {
      if (!track || track.observed !== true || track.velocityKnown !== true || track.shadow === true
        || track.id == null || seen.has(track.id) || track.radius <= 0
        || ![track.x, track.y, track.radius, track.measuredVx, track.measuredVy].every(finite)) continue;
      seen.add(track.id); tracks.push(track);
      if (tracks.length === 32) break;
    }
    return tracks;
  }
  function wallGroup(tracks, side, pointer, steering, center) {
    const { axis, tangent, velocity, sign } = side;
    const eligible = tracks.filter(track => {
      if (Math.abs(track[velocity]) > track.radius * 0.2 || sign * (track[axis] - center[axis]) <= 0) return false;
      const dx = pointer.x - track.x, dy = pointer.y - track.y, distance = Math.hypot(dx, dy);
      const thrust = (axis === 'x' ? dx : dy) * (steering === 'repel' ? -1 : 1);
      return distance > 1e-9 && sign * thrust / distance > 0.35;
    });
    if (eligible.length < 3) return null;
    const radius = median(eligible.map(track => track.radius));
    let best = null;
    // At most 32 tracks: bounded small clusters, with no pairwise geometry grid.
    for (const anchor of eligible) {
      const group = eligible.filter(track => Math.abs(track[axis] - anchor[axis]) <= radius * 0.2);
      if (group.length < 3) continue;
      const groupRadius = median(group.map(track => track.radius));
      const plane = median(group.map(track => track[axis]));
      if (group.some(track => Math.abs(track[axis] - plane) > groupRadius * 0.2)) continue;
      const span = Math.max(...group.map(track => track[tangent])) - Math.min(...group.map(track => track[tangent]));
      if (span < groupRadius * 3) continue;
      if (!best || group.length > best.tracks.length) best = { tracks: group, plane, radius: groupRadius };
    }
    return best;
  }
  class Detector {
    constructor() { this.reset(); }
    reset() {
      this._bounds = {}; this._sources = {}; this._candidates = {}; this._contradictions = {}; this._time = null;
      this._paintedBounds = null;
      this._measurements = {};
    }
    get bounds() { return { ...this._bounds }; }
    get sources() { return { ...this._sources }; }
    get paintedBounds() { return this._paintedBounds ? { ...this._paintedBounds } : null; }
    get measurements() { return Object.fromEntries(Object.entries(this._measurements).map(([side,value])=>[side,{...value}])); }
    setPaintedBounds(rect) {
      if (!rect || !Object.keys(SIDES).every(side => finite(rect[side]) && Math.abs(rect[side]) <= 1e7)
        || rect.left >= rect.right || rect.top >= rect.bottom) return false;
      const changed = !this._paintedBounds || Object.keys(SIDES).some(side =>
        Math.abs(rect[side] - this._paintedBounds[side]) > RECT_TOLERANCE);
      if (!changed) return true;
      this._paintedBounds = Object.fromEntries(Object.keys(SIDES).map(side => [side, rect[side]]));
      this._candidates = {}; this._contradictions = {};
      for (const side of Object.keys(SIDES)) this._restoreAutomatic(side);
      return true;
    }
    _automatic(side) { return this._paintedBounds[side] + SIDES[side].sign * PADDING; }
    _restoreAutomatic(side) {
      this._bounds[side] = this._automatic(side); this._sources[side] = 'arena';
      delete this._measurements[side];
    }
    set(side, value) {
      if (this._paintedBounds || !Object.hasOwn(SIDES, side) || !finite(value)) return false;
      const { opposite, sign } = SIDES[side], other = this._bounds[opposite];
      if (finite(other) && sign * (value - other) <= 0) return false;
      this._bounds[side] = value; this._sources[side] = 'manual';
      delete this._candidates[side]; delete this._contradictions[side];
      delete this._measurements[side];
      return true;
    }
    observe(input, time, { pointer = null, steering = 'coast', viewBounds = null } = {}) {
      if (!finite(time)) {
        this._time = null; this._candidates = {}; this._contradictions = {}; return;
      }
      if (this._time !== null && (time < this._time || time - this._time > 1)) {
        this._candidates = {}; this._contradictions = {};
      }
      this._time = time;
      const tracks = actuals(input);
      const controlled = ['attract', 'repel'].includes(steering) && pointer && [pointer.x, pointer.y].every(finite);
      const validView = viewBounds && [viewBounds.left, viewBounds.top, viewBounds.width, viewBounds.height].every(finite)
        && viewBounds.width > 0 && viewBounds.height > 0;
      const center = validView ? { x: viewBounds.left + viewBounds.width / 2, y: viewBounds.top + viewBounds.height / 2 } : null;
      for (const [name, side] of Object.entries(SIDES)) {
        if (this._sources[name] === 'manual') continue;
        if (this._sources[name] === 'learned') {
          const crossed = tracks.filter(track => side.sign * (track[side.axis] - this._bounds[name]) > track.radius * 0.5);
          let contradiction = this._contradictions[name];
          if (crossed.length < 2) { delete this._contradictions[name]; continue; }
          if (!contradiction || shared(contradiction.ids, crossed) < 2) {
            contradiction = { since: time, ids: new Set(crossed.map(track => track.id)) };
            this._contradictions[name] = contradiction;
          }
          if (time - contradiction.since >= 0.15 - 1e-9) {
            if (this._paintedBounds) this._restoreAutomatic(name);
            else { delete this._bounds[name]; delete this._sources[name]; }
            delete this._contradictions[name];
            delete this._candidates[name];
          }
          continue;
        }
        const group = controlled && center ? wallGroup(tracks, side, pointer, steering, center) : null;
        if (!group || (this._paintedBounds && Math.abs(group.plane - this._automatic(name)) > REFINEMENT_RANGE)) {
          delete this._candidates[name]; continue;
        }
        let candidate = this._candidates[name];
        if (!candidate || Math.abs(group.plane - candidate.anchor) > Math.min(group.radius, candidate.radius) * 0.2
          || shared(candidate.ids, group.tracks) < 3) {
          candidate = { since: time, anchor: group.plane, radius: group.radius, ids: new Set(group.tracks.map(track => track.id)),
            min:Infinity,max:-Infinity,frames:0 };
          this._candidates[name] = candidate;
        }
        candidate.min=Math.min(candidate.min,...group.tracks.map(track=>track[side.axis]));
        candidate.max=Math.max(candidate.max,...group.tracks.map(track=>track[side.axis]));
        candidate.frames++;
        if (time - candidate.since < 0.8 - 1e-9) continue;
        const other = this._bounds[side.opposite];
        if (!finite(other) || side.sign * (group.plane - other) > 0) {
          this._bounds[name] = group.plane; this._sources[name] = 'learned';
          if(this._paintedBounds){
            const edge=this._paintedBounds[name],a=side.sign*(candidate.min-edge),b=side.sign*(candidate.max-edge);
            this._measurements[name]={margin:side.sign*(group.plane-edge),minimum:Math.min(a,b),maximum:Math.max(a,b),
              drones:group.tracks.length,frames:candidate.frames,duration:time-candidate.since};
          }
        }
        delete this._candidates[name];
      }
    }
  }
  return { Detector };
});


/* Observe player controls without consuming or changing the game's events. */
(function(root){
  'use strict';
  const DEFAULTS={fire:[32,0],secondaryFire:[16,2],toggleAutoFire:[69]};
  function install({getCanvas,isBlocked=()=>false}){
    const doc=root.document,removers=[],keys=new Map(),mouse=new Set();
    let pointer=null,autoFire=false,suspended=false;
    function listen(type,fn){root.addEventListener(type,fn,true);removers.push(()=>root.removeEventListener(type,fn,true));}
    function bindings(){
      let saved;try{saved=JSON.parse(root.localStorage.getItem('keybinds')||'null');}catch{}
      return Object.fromEntries(Object.entries(DEFAULTS).map(([key,value])=>[key,
        Array.isArray(saved?.[key])?saved[key].filter(n=>Number.isInteger(n)&&n>=0&&n<=255):value]));
    }
    function blocked(event){
      if(!getCanvas()||doc.hidden||isBlocked())return true;
      const path=event.composedPath?.()||[event.target];
      if(path.some(node=>['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(node?.tagName)
        ||node?.isContentEditable||node?.id==='diep-fov-controls'||node?.id==='keybinds-menu-click-blocker'
        ||node?.getAttribute?.('role')==='textbox'))return true;
      const modal=doc.querySelector?.('dialog[open], [aria-modal="true"]:not([aria-hidden="true"]):not([hidden])');
      return !!(modal&&modal.getClientRects().length);
    }
    function gamePoint(event){
      if(blocked(event))return false;
      const r=getCanvas()?.getBoundingClientRect();
      return r&&Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)
        &&event.clientX>=r.left&&event.clientX<=r.left+r.width&&event.clientY>=r.top&&event.clientY<=r.top+r.height;
    }
    function pointerAt(event){pointer={x:event.clientX,y:event.clientY};suspended=false;}
    function down(event){
      if(event.isPrimary===false||!gamePoint(event)||![0,1,2].includes(event.button))return;
      pointerAt(event);
      if(!mouse.has(event.button)&&bindings().toggleAutoFire.includes(event.button))autoFire=!autoFire;
      mouse.add(event.button);
    }
    function up(event){mouse.delete(event.button);}
    function move(event){
      if(event.isPrimary===false||!gamePoint(event))return;
      pointerAt(event);
      // Recover a held button even when the initial press landed on a game UI
      // layer or outside the browser. A move with no buttons clears stale holds.
      if(Number.isInteger(event.buttons)){
        mouse.clear();for(const [bit,button] of [[1,0],[4,1],[2,2]])if(event.buttons&bit)mouse.add(button);
      }
    }
    function keyCode(event){
      let n=event.keyCode||event.which;
      if(!n){
        if(event.code==='Space')n=32;
        else if(/^Shift/.test(event.code||''))n=16;
        else if(/^Key[A-Z]$/.test(event.code||''))n=event.code.charCodeAt(3);
        else if(/^Digit[0-9]$/.test(event.code||''))n=event.code.charCodeAt(5);
      }
      return ({59:186,61:187,173:189})[n]||n;
    }
    function keydown(event){
      if(blocked(event)||event.ctrlKey||event.metaKey||event.altKey)return;
      const n=keyCode(event),id=event.code||String(n);if(!Number.isInteger(n))return;
      const first=!keys.has(id);keys.set(id,n);suspended=false;
      if(first&&!event.repeat&&bindings().toggleAutoFire.includes(n))autoFire=!autoFire;
    }
    function keyup(event){keys.delete(event.code||String(keyCode(event)));}
    function release(){keys.clear();mouse.clear();pointer=null;suspended=true;}
    function state(){
      const b=bindings(),held=new Set([...mouse,...keys.values()]);
      const pressed=name=>b[name].some(n=>held.has(n));
      const steering=suspended?'coast':pressed('secondaryFire')?'repel':pressed('fire')||autoFire?'attract':'coast';
      return {pointer:pointer&&{...pointer},steering,autoFire};
    }
    for(const name of ['pointerdown','mousedown'])listen(name,down);
    for(const name of ['pointerup','mouseup'])listen(name,up);
    for(const name of ['pointermove','mousemove'])listen(name,move);
    listen('keydown',keydown);listen('keyup',keyup);
    // Capture listeners also receive blur from focused buttons/fields. Clicking
    // back onto the canvas must retain the pointer captured on pointerdown.
    listen('blur',event=>{if(event.target===root)release();});listen('pointercancel',release);
    doc.addEventListener('visibilitychange',release);removers.push(()=>doc.removeEventListener('visibilitychange',release));
    return {get state(){return state();},release,destroy(){release();removers.forEach(fn=>fn());}};
  }
  root.DiepShadowInput={install};
})(globalThis);


/* Draw short-lived predictions from observed drones; never invent observations. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepDroneShadows = api;
})(globalThis, function (root) {
  'use strict';
  const STORAGE = 'diep-drone-shadows-v1';
  function projection(canvas, rect, camera, fov) {
    if (!canvas || !rect || !camera?.ok || !fov || ![canvas.width, canvas.height,
      rect.width, rect.height, camera.x, camera.y, camera.scale].every(Number.isFinite)
      || Math.min(canvas.width, canvas.height, rect.width, rect.height, camera.scale) <= 0) return null;
    const multiplier = fov.enabled ? fov.multiplier : 1;
    if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
    const scaleX = camera.scale * rect.width / canvas.width;
    const scaleY = camera.scale * rect.height / canvas.height;
    const width = canvas.width / camera.scale / multiplier;
    const height = canvas.height / camera.scale / multiplier;
    return {
      bounds:{left:camera.x-width/2, top:camera.y-height/2, width, height},
      screenBounds:{left:(rect.width-rect.width/multiplier)/2, top:(rect.height-rect.height/multiplier)/2,
        width:rect.width/multiplier, height:rect.height/multiplier},
      toWorld:p=>({x:camera.x+(p.x-canvas.width/2)/camera.scale,
        y:camera.y+(p.y-canvas.height/2)/camera.scale}),
      pointer:p=>({x:Math.max(camera.x-width/2,Math.min(camera.x+width/2,
          camera.x+(p.x-rect.left-rect.width/2)/scaleX)),
        y:Math.max(camera.y-height/2,Math.min(camera.y+height/2,
          camera.y+(p.y-rect.top-rect.height/2)/scaleY))}),
      rawPointer:p=>({x:camera.x+(p.x-rect.left-rect.width/2)/scaleX,
        y:camera.y+(p.y-rect.top-rect.height/2)/scaleY}),
      toScreen:p=>({x:rect.width/2+(p.x-camera.x)*scaleX,
        y:rect.height/2+(p.y-camera.y)*scaleY}),
      radius:r=>r*Math.sqrt(scaleX*scaleY)
    };
  }
  function install({getStatus, getCamera} = {}) {
    const doc = root.document, removers = [], tracker = new root.DroneShadows.Tracker();
    const arena = new root.DiepArenaLimits.Detector();
    const config = {enabled:true, color:null, maxAge:15};
    let overlay=null, ctx=null, ui=null, canvas=null, rect=null, projected=null;
    let observations=[], shadows=[], picking=false, suppressClick=false;
    const input=root.DiepShadowInput.install({getCanvas:()=>canvas,isBlocked:()=>picking});
    let frame=-1, lastFrame=-Infinity, previousCanvas=null, lastCorner=null, destroyed=false;
    let message='Pick one of your visible drones to start.', lastUI=-Infinity;
    try {
      const saved=JSON.parse(root.localStorage.getItem(STORAGE)||'null');
      if(saved?.version===1||saved?.version===2){
        if(typeof saved.enabled==='boolean')config.enabled=saved.enabled;
        if(/^#[0-9a-f]{6}$/i.test(saved.color))config.color=saved.color.toLowerCase();
        if(Number.isFinite(saved.maxAge))config.maxAge=Math.max(.5,Math.min(60,saved.version===1?Math.max(15,saved.maxAge):saved.maxAge));
      }
    } catch {}
    function listen(target,type,fn,options){
      target.addEventListener(type,fn,options);removers.push(()=>target.removeEventListener(type,fn,options));
    }
    function clear(){tracker.reset();shadows=[];ctx?.clearRect(0,0,overlay.width,overlay.height);}
    function persist(){try{root.localStorage.setItem(STORAGE,JSON.stringify({...config,version:2}));}catch{}}
    function configure(next={}){
      if(destroyed)return;
      const oldColor=config.color,oldEnabled=config.enabled;
      if(typeof next.enabled==='boolean')config.enabled=next.enabled;
      if(next.color===null||/^#[0-9a-f]{6}$/i.test(next.color))config.color=next.color?.toLowerCase()??null;
      if(Number.isFinite(next.maxAge))config.maxAge=Math.max(.5,Math.min(60,next.maxAge));
      picking=false;
      if(config.color!==oldColor||config.enabled!==oldEnabled)clear();
      persist();syncConfigUI();refresh();
    }
    function syncConfigUI(){
      if(!ui)return;
      // Only synchronize after an explicit configuration change. Periodic
      // status updates must not replace a native color-picker preview or draft.
      const values={'#shadow-color':config.color||'#00b2e1',
        '#shadow-hex':config.color||'', '#shadow-age':String(config.maxAge)};
      for(const [selector,value] of Object.entries(values)){
        const field=ui.querySelector(selector);if(field.value!==value)field.value=value;
      }
    }
    function refresh(){
      if(!ui)return;
      ui.querySelector('#shadow-toggle').textContent='Drone shadows: '+(config.enabled?'On':'Off');
      ui.querySelector('#shadow-toggle').setAttribute('aria-pressed',String(config.enabled));
      ui.querySelector('#shadow-pick').textContent=picking?'Cancel picking':'Pick my drones';
      const refined=Object.values(arena.sources).filter(source=>source==='learned').length;
      ui.querySelector('#arena-status').textContent=arena.paintedBounds
        ?`Arena walls: automatic${refined?' · refined from visible drones':' · default margin 200 units'}`
        :'Arena walls: waiting for arena data.';
      const measured=Object.entries(arena.measurements);
      ui.querySelector('#arena-measurement').textContent=measured.length
        ?measured.map(([side,m])=>`Observed ${side} margin: ${m.margin.toFixed(1)} units · range ${m.minimum.toFixed(1)}–${m.maximum.toFixed(1)} · ${m.drones} drones`).join('\n')
        :'Margin not measured yet. 200 units is the default estimate. Hold 3+ visible drones spread against a wall to measure automatically.';
      ui.querySelector('#shadow-status').textContent=picking?'Click one of your visible drones.':!config.enabled?'Predicted drones paused.':message;
      ui.querySelector('#shadow-selection').textContent=config.color?'Selected: '+config.color:'No drone color selected.';
      const controls=input.state;
      ui.querySelector('#shadow-input').textContent=`Input: ${controls.steering}${controls.autoFire?' · auto-fire on':''}`;
    }
    function mountControls(parent){
      if(ui||destroyed)return;
      ui=doc.createElement('div');
      ui.innerHTML=`<div class="row"><button type="button" id="shadow-toggle" style="width:100%"></button></div>
        <p class="hint" id="shadow-status" role="status"></p>
        <details style="margin-top:8px"><summary style="cursor:pointer">Drone shadow settings</summary>
        <div class="row"><button type="button" id="shadow-pick">Pick my drones</button></div>
        <label style="display:block;margin-top:8px">My drone color <input type="color" id="shadow-color" value="#00b2e1" style="width:50px;height:25px;vertical-align:middle"></label>
        <div class="row"><label>Hex code <input type="text" id="shadow-hex" maxlength="7" placeholder="#b070ff" spellcheck="false" style="width:80px"></label><button type="button" id="shadow-apply">Apply</button></div>
        <p class="hint" id="shadow-selection"></p><p class="hint" id="shadow-color-message" role="status"></p>
        <label style="display:block;margin-top:8px">Keep shadows for <input type="number" id="shadow-age" min="0.5" max="60" step="0.5" value="15" style="width:50px"> seconds</label>
        <p class="hint" id="shadow-input" role="status"></p>
        <p class="hint" id="arena-status" role="status"></p>
        <p class="hint" id="arena-measurement" role="status" style="white-space:pre-line"></p>
        <p class="hint">The drone movement limit follows the arena automatically, including the small margin beyond its painted edge. Amber dashes show the estimated limit. No wall setup is needed.</p>
        <p class="hint">Purple shadows use momentum and drag. Left mouse/Space attracts, right mouse/Shift repels, E toggles auto-fire; custom bindings are read automatically. Their target stays inside the red normal-FOV box, even if your mouse moves beyond it. Actual game aiming is unchanged. Shared team colors can include teammates' drones.</p></details>`;
      parent.appendChild(ui);
      listen(ui.querySelector('#shadow-toggle'),'click',()=>configure({enabled:!config.enabled}));
      listen(ui.querySelector('#shadow-pick'),'click',()=>{picking=!picking;refresh();});
      const color=ui.querySelector('#shadow-color'), hex=ui.querySelector('#shadow-hex');
      function chooseColor(value){configure({color:value});ui.querySelector('#shadow-color-message').textContent='';}
      // Native pickers may send preview input events before their final change.
      listen(color,'input',event=>chooseColor(event.target.value));
      listen(color,'change',event=>chooseColor(event.target.value));
      function applyHex(){
        const value=hex.value.trim();
        if(!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)){
          ui.querySelector('#shadow-color-message').textContent='Enter a hex color such as #b070ff.';return;
        }
        chooseColor(root.DroneCursorModel.normalizeColor(value));
      }
      listen(ui.querySelector('#shadow-apply'),'click',applyHex);
      listen(hex,'keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyHex();}});
      listen(ui.querySelector('#shadow-age'),'change',event=>configure({maxAge:Number(event.target.value)}));
      syncConfigUI();refresh();
    }
    function extract(samples, camera, headingVertex){
      const result=[], model=root.DroneCursorModel;
      for(const sample of samples){
        if(!sample||!Number.isFinite(sample.x)||!Number.isFinite(sample.y)||sample.vertices?.length!==3)continue;
        const color=model.normalizeColor(sample.color), tip=sample.vertices[headingVertex];
        if(!color||!tip||![tip.x,tip.y].every(Number.isFinite))continue;
        const p=projected.toWorld(sample), dx=(tip.x-sample.x)/camera.scale,dy=(tip.y-sample.y)/camera.scale;
        const radius=Math.hypot(dx,dy), screenRadius=projected.radius(radius);
        if(!Number.isFinite(radius)||screenRadius<2||screenRadius>70)continue;
        if(result.some(existing=>model.colorsMatch(existing.color,color)&&Math.hypot(existing.x-p.x,existing.y-p.y)<Math.max(radius,existing.radius)*.35))continue;
        const screen=projected.toScreen(p);
        result.push({...p,dx:dx/radius,dy:dy/radius,radius,color,screenX:screen.x,screenY:screen.y,screenRadius});
      }
      return result.slice(0,128);
    }
    function render(){
      if(!ctx||!rect)return;
      const dpr=root.devicePixelRatio||1,w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
      if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
      Object.assign(overlay.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
      if(!config.enabled||!projected)return;
      const b=projected.screenBounds;
      ctx.save();ctx.beginPath();ctx.rect(0,0,rect.width,rect.height);
      ctx.rect(b.left,b.top,b.width,b.height);ctx.clip('evenodd');
      let shown=0;
      for(const shadow of shadows){
        const p=projected.toScreen(shadow),r=Math.max(3,projected.radius(shadow.radius));
        if(p.x+r<0||p.x-r>rect.width||p.y+r<0||p.y-r>rect.height)continue;
        const fadeDuration=Math.min(3,config.maxAge*.2);
        const alpha=Math.max(0,Math.min(1,(config.maxAge-shadow.age)/fadeDuration));
        ctx.save();ctx.globalAlpha=alpha;ctx.translate(p.x,p.y);ctx.rotate(Math.atan2(shadow.dy,shadow.dx));
        ctx.beginPath();
        for(let i=0;i<3;i++){const angle=i*Math.PI*2/3;
          if(i)ctx.lineTo(r*Math.cos(angle),r*Math.sin(angle));else ctx.moveTo(r,0);}
        ctx.closePath();ctx.fillStyle='#a35dff77';ctx.strokeStyle='#ddb8ff';ctx.lineWidth=1.5;ctx.setLineDash([3,2]);ctx.fill();ctx.stroke();ctx.restore();shown++;
      }
      ctx.restore();
      if(shown){ctx.font='11px system-ui,sans-serif';ctx.fillStyle='#ddb8ff';ctx.fillText('Purple = predicted drones',8,16);}
      ctx.save();ctx.strokeStyle='#ffc66eaa';ctx.lineWidth=1;ctx.setLineDash([6,5]);
      for(const [side,value] of Object.entries(arena.bounds)){
        const vertical=side==='left'||side==='right';
        const p=projected.toScreen(vertical?{x:value,y:0}:{x:0,y:value});
        ctx.beginPath();if(vertical){ctx.moveTo(p.x,0);ctx.lineTo(p.x,rect.height);}
        else{ctx.moveTo(0,p.y);ctx.lineTo(rect.width,p.y);}ctx.stroke();
      }
      ctx.restore();
    }
    function update({canvas:nextCanvas,samples,frameId,ms,headingVertex=0}){
      if(destroyed)return;
      try{
        canvas=nextCanvas;rect=canvas?.getBoundingClientRect();
        if(!config.enabled||doc.hidden||!rect?.width||!rect?.height){clear();observations=[];return;}
        if(previousCanvas!==canvas||lastCorner!==headingVertex){
          if(previousCanvas&&previousCanvas!==canvas)arena.reset();
          clear();frame=-1;previousCanvas=canvas;lastCorner=headingVertex;
        }
        const camera=getCamera?.(), fov=getStatus?.();
        projected=projection(canvas,rect,camera,fov);
        if(projected&&camera.arenaBounds){
          if(!arena.setPaintedBounds(camera.arenaBounds))arena.reset();
        }else if(arena.paintedBounds)arena.reset();
        if(!projected){clear();observations=[];message='Waiting for the supported game camera.';}
        else if(frameId!==frame||samples.length){
          frame=frameId;lastFrame=ms;
          observations=extract(samples,camera,headingVertex);
          if(!config.color){clear();message='Pick one of your visible drones to start.';}
          else{
            const selected=observations.filter(p=>root.DroneCursorModel.colorsMatch(p.color,config.color));
            const {steering,pointer}=input.state;
            const target=pointer?projected.pointer(pointer):null;
            shadows=tracker.update(selected,ms/1000,{bounds:projected.bounds,arena:arena.bounds,
              pointer:target,steering,maxAge:config.maxAge});
            if(arena.paintedBounds)arena.observe(tracker.tracks,ms/1000,{pointer:target,steering,viewBounds:projected.bounds});
            const tracked=tracker.counts.tracked;
            message=`${selected.length} visible · ${shadows.length} predicted · ${tracked} tracked`;
            if(!(fov.enabled&&fov.multiplier>1.01))message+=' · zoom out above 1×';
          }
        }else if(ms-lastFrame>250){clear();observations=[];message='Waiting for fresh drone frames.';}
        render();if(ms-lastUI>150){refresh();lastUI=ms;}
      }catch(error){clear();config.enabled=false;message='Shadows paused: '+error.message;refresh();}
    }
    function onCanvas(event){
      if(event.target===canvas)return true;
      if(!canvas||!rect)return false;
      const path=event.composedPath?.()||[event.target];
      if(path.some(node=>node?.id==='diep-fov-controls'||node?.id==='keybinds-menu-click-blocker'
        ||['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(node?.tagName)||node?.isContentEditable))return false;
      return Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)
        &&event.clientX>=rect.left&&event.clientX<=rect.left+rect.width
        &&event.clientY>=rect.top&&event.clientY<=rect.top+rect.height;
    }
    function consume(event){event.preventDefault();event.stopImmediatePropagation();}
    listen(root,'pointerdown',event=>{
      if(event.isPrimary===false||!onCanvas(event))return;
      if(picking){
        consume(event);suppressClick=true;
        const x=event.clientX-rect.left,y=event.clientY-rect.top;
        const selected=observations.map(p=>({p,d:Math.hypot(p.screenX-x,p.screenY-y)}))
          .filter(item=>item.d<=Math.max(18,item.p.screenRadius*2)).sort((a,b)=>a.d-b.d)[0]?.p;
        if(selected){configure({color:selected.color,enabled:true});message='Drone color selected. Watching their movement.';}
        else message='No captured drone there. Try a visible triangle.';
        refresh();return;
      }
    },true);
    for(const name of ['mousedown','mouseup','click','contextmenu'])listen(root,name,event=>{
      if(suppressClick&&onCanvas(event)){consume(event);if(name==='click'||name==='contextmenu')suppressClick=false;}
    },true);
    listen(root,'pointerup',event=>{
      if(suppressClick&&onCanvas(event))consume(event);},true);
    listen(root,'pointercancel',()=>{suppressClick=false;clear();},true);
    listen(root,'blur',()=>{suppressClick=false;clear();});
    listen(doc,'visibilitychange',clear);
    function boot(){if(destroyed)return;overlay=doc.createElement('canvas');overlay.id='diep-drone-shadows';
      overlay.setAttribute('aria-hidden','true');overlay.style.cssText='all:initial;position:fixed;pointer-events:none;z-index:2147483060';
      doc.documentElement.appendChild(overlay);ctx=overlay.getContext('2d');}
    if(doc.readyState==='loading')listen(doc,'DOMContentLoaded',boot,{once:true});else boot();
    return {mountControls,configure,update,reset:clear,
      setWall(side,value){const ok=arena.set(side,value);refresh();return ok;},
      clearWalls(){arena.reset();refresh();},
      get status(){return {config:{...config},message,picking,steering:input.state.steering,autoFire:input.state.autoFire,
        pointer:input.state.pointer,
        target:projected&&input.state.pointer?projected.pointer(input.state.pointer):null,
        arena:{bounds:arena.bounds,sources:arena.sources,paintedBounds:arena.paintedBounds,measurements:arena.measurements},
        counts:tracker.counts,shadows:shadows.map(p=>({...p})),tracks:tracker.tracks};},
      destroy(){if(destroyed)return;destroyed=true;clear();input.destroy();removers.forEach(fn=>fn());overlay?.remove();ui?.remove();}
    };
  }
  return {install,projection};
});


/* Temporal opponent position regions.
 *
 * Multi-hypothesis kinematic set-membership tracker.
 *
 * A single axis-aligned [x,y,vx,vy] box loses correlations. For example,
 * "left position implies rightward velocity" and "right position implies
 * leftward velocity" collapse into one large box that also invents impossible
 * combinations. This tracker keeps many small state boxes instead.
 *
 * Each hypothesis stores:
 *   - a feasible position rectangle
 *   - feasible vx and vy intervals
 *
 * On every accepted observation:
 *   1. predict each hypothesis with bounded velocity/acceleration,
 *   2. intersect each predicted position with the new observation,
 *   3. discard hypotheses with no overlap,
 *   4. narrow each surviving velocity interval using the observed displacement.
 *
 * The visible feasible set is the UNION of the surviving small rectangles,
 * rather than one giant rectangle. A bounding hull is still exposed for status
 * compatibility, but the overlay renders the individual regions.
 */
(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./inference.js') : root.DroneInference);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiepPlayerRegion = api;
})(typeof globalThis === 'object' ? globalThis : this, function (inference) {
  'use strict';

  const finite = Number.isFinite;
  const halfWidth = 1920 / 0.39775344729423523 / 2;

  const POSITION_BINS = 3;
  const VELOCITY_BINS = 5;
  const MAX_HYPOTHESES = 384;

  const DEFAULTS = Object.freeze({
    maxSpeed: 532,
    maxAcceleration: 1000,
    expireAfterSeconds: 7,
    sampleIntervalSeconds: 0,
    halfWidth,
    halfHeight: halfWidth * 9 / 16,
    padding: 0
  });

  const LIMITS = Object.freeze({
    maxSpeed: Object.freeze([0, 5000]),
    maxAcceleration: Object.freeze([0, 20000]),
    expireAfterSeconds: Object.freeze([0.1, 60]),
    sampleIntervalSeconds: Object.freeze([0, 1]),
    halfWidth: Object.freeze([1, 20000]),
    halfHeight: Object.freeze([1, 20000]),
    padding: Object.freeze([0, 5000])
  });

  const keys = Object.keys(DEFAULTS);

  const copyBox = box => box && ({
    minX: box.minX, minY: box.minY,
    maxX: box.maxX, maxY: box.maxY
  });

  const copyVelocity = v => v && ({
    minX: v.minX, maxX: v.maxX,
    minY: v.minY, maxY: v.maxY
  });

  const copyHypothesis = h => h && ({
    box: copyBox(h.box),
    velocity: copyVelocity(h.velocity)
  });

  const validBox = box => !!box
    && [box.minX, box.minY, box.maxX, box.maxY].every(finite)
    && box.minX <= box.maxX && box.minY <= box.maxY;

  const validVelocity = v => !!v
    && [v.minX, v.maxX, v.minY, v.maxY].every(finite)
    && v.minX <= v.maxX && v.minY <= v.maxY;

  function intersectBoxes(a, b) {
    if (!validBox(a) || !validBox(b)) return null;
    const box = {
      minX: Math.max(a.minX, b.minX),
      minY: Math.max(a.minY, b.minY),
      maxX: Math.min(a.maxX, b.maxX),
      maxY: Math.min(a.maxY, b.maxY)
    };
    return validBox(box) ? box : null;
  }

  function intersectVelocity(a, b) {
    if (!validVelocity(a) || !validVelocity(b)) return null;
    const v = {
      minX: Math.max(a.minX, b.minX),
      maxX: Math.min(a.maxX, b.maxX),
      minY: Math.max(a.minY, b.minY),
      maxY: Math.min(a.maxY, b.maxY)
    };
    return validVelocity(v) ? v : null;
  }

  function clampVelocity(v, maxSpeed) {
    if (!validVelocity(v)) return null;
    const result = {
      minX: Math.max(-maxSpeed, v.minX),
      maxX: Math.min(maxSpeed, v.maxX),
      minY: Math.max(-maxSpeed, v.minY),
      maxY: Math.min(maxSpeed, v.maxY)
    };
    return validVelocity(result) ? result : null;
  }

  function hullOf(boxes) {
    const good = boxes.filter(validBox);
    if (!good.length) return null;
    return {
      minX: Math.min(...good.map(b => b.minX)),
      minY: Math.min(...good.map(b => b.minY)),
      maxX: Math.max(...good.map(b => b.maxX)),
      maxY: Math.max(...good.map(b => b.maxY))
    };
  }

  function splitRange(min, max, bins) {
    if (!finite(min) || !finite(max) || max < min || bins < 1) return [];
    if (max === min) return [{ min, max }];
    const step = (max - min) / bins;
    const out = [];
    for (let i = 0; i < bins; i++) {
      out.push({
        min: min + i * step,
        max: i === bins - 1 ? max : min + (i + 1) * step
      });
    }
    return out;
  }

  function initialHypotheses(observation, maxSpeed) {
    const xs = splitRange(observation.minX, observation.maxX, POSITION_BINS);
    const ys = splitRange(observation.minY, observation.maxY, POSITION_BINS);
    const vxs = splitRange(-maxSpeed, maxSpeed, VELOCITY_BINS);
    const vys = splitRange(-maxSpeed, maxSpeed, VELOCITY_BINS);
    const result = [];

    for (const x of xs) for (const y of ys) {
      for (const vx of vxs) for (const vy of vys) {
        result.push({
          box: { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max },
          velocity: { minX: vx.min, maxX: vx.max, minY: vy.min, maxY: vy.max }
        });
      }
    }
    return result.slice(0, MAX_HYPOTHESES);
  }

  function normalizeConfig(patch = {}, previous = DEFAULTS) {
    const result = {};
    for (const key of keys) {
      const value = finite(patch?.[key]) ? patch[key]
        : finite(previous?.[key]) ? previous[key] : DEFAULTS[key];
      const [min, max] = LIMITS[key];
      result[key] = Math.max(min, Math.min(max, value));
    }
    return result;
  }

  function positionRegionKey(box) {
    // Only for display de-duplication. This does NOT merge the underlying
    // trajectory hypotheses or alter filtering.
    const q = v => Math.round(v * 1000) / 1000;
    return [q(box.minX), q(box.minY), q(box.maxX), q(box.maxY)].join(',');
  }

  function uniqueRegions(hypotheses) {
    const seen = new Set();
    const result = [];
    for (const h of hypotheses) {
      if (!validBox(h.box)) continue;
      const key = positionRegionKey(h.box);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(copyBox(h.box));
    }
    return result;
  }

  function maxDisplacement(v0, dt, acceleration, maxSpeed) {
    if (dt <= 0) return 0;
    v0 = Math.max(-maxSpeed, Math.min(maxSpeed, v0));
    if (acceleration <= 0 || v0 >= maxSpeed) return v0 * dt;

    const toCap = (maxSpeed - v0) / acceleration;
    if (toCap >= dt) return v0 * dt + 0.5 * acceleration * dt * dt;

    return v0 * toCap
      + 0.5 * acceleration * toCap * toCap
      + maxSpeed * (dt - toCap);
  }

  function minDisplacement(v0, dt, acceleration, maxSpeed) {
    if (dt <= 0) return 0;
    v0 = Math.max(-maxSpeed, Math.min(maxSpeed, v0));
    if (acceleration <= 0 || v0 <= -maxSpeed) return v0 * dt;

    const toCap = (v0 + maxSpeed) / acceleration;
    if (toCap >= dt) return v0 * dt - 0.5 * acceleration * dt * dt;

    return v0 * toCap
      - 0.5 * acceleration * toCap * toCap
      - maxSpeed * (dt - toCap);
  }

  function splitHypothesisOnce(h) {
    if (!h || !validBox(h.box) || !validVelocity(h.velocity)) return [h];

    const spans = [
      { key: 'x', span: h.box.maxX - h.box.minX },
      { key: 'y', span: h.box.maxY - h.box.minY },
      { key: 'vx', span: h.velocity.maxX - h.velocity.minX },
      { key: 'vy', span: h.velocity.maxY - h.velocity.minY }
    ].sort((a, b) => b.span - a.span);

    const key = spans[0].key;
    if (!(spans[0].span > 1e-6)) return [copyHypothesis(h)];

    const a = copyHypothesis(h), b = copyHypothesis(h);

    if (key === 'x') {
      const mid = (h.box.minX + h.box.maxX) / 2;
      a.box.maxX = mid; b.box.minX = mid;
    } else if (key === 'y') {
      const mid = (h.box.minY + h.box.maxY) / 2;
      a.box.maxY = mid; b.box.minY = mid;
    } else if (key === 'vx') {
      const mid = (h.velocity.minX + h.velocity.maxX) / 2;
      a.velocity.maxX = mid; b.velocity.minX = mid;
    } else {
      const mid = (h.velocity.minY + h.velocity.maxY) / 2;
      a.velocity.maxY = mid; b.velocity.minY = mid;
    }

    return [a, b];
  }

  function refineHypotheses(hypotheses, maxCount) {
    // Exact partitioning only: splitting does NOT remove any feasible state.
    // Stop when the cap is reached instead of truncating trajectories.
    let result = hypotheses.map(copyHypothesis).filter(Boolean);

    while (result.length < maxCount) {
      let bestIndex = -1;
      let bestScore = 0;

      for (let i = 0; i < result.length; i++) {
        const h = result[i];
        const score = Math.max(
          h.box.maxX - h.box.minX,
          h.box.maxY - h.box.minY,
          h.velocity.maxX - h.velocity.minX,
          h.velocity.maxY - h.velocity.minY
        );
        if (score > bestScore + 1e-9) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex < 0 || bestScore <= 1e-6) break;

      const parts = splitHypothesisOnce(result[bestIndex]);
      if (parts.length !== 2) break;
      result.splice(bestIndex, 1, ...parts);
    }

    return result;
  }

  class HypothesisRegion {
    constructor(config = {}) {
      this.configure(config);
      this.reset('empty');
    }

    configure(config = {}) {
      this.maxSpeed = config.maxSpeed ?? 0;
      this.maxAcceleration = config.maxAcceleration ?? 0;
      this.expireAfterSeconds = config.expireAfterSeconds ?? 3;
    }

    reset(reason = 'reset') {
      this.hypotheses = [];
      this.observedAt = null;
      this.lastTime = null;
      this.status = reason;
      return {
        status: reason,
        box: null,
        regions: [],
        hypotheses: [],
        ageSeconds: null
      };
    }

    _timeError(timeSeconds) {
      if (!finite(timeSeconds)) return 'invalid-time';
      if (this.lastTime !== null && timeSeconds < this.lastTime) return 'non-monotonic-time';
      return null;
    }

    _predictHypothesis(h, dt) {
      if (!h || !validBox(h.box) || !validVelocity(h.velocity)) return null;

      const a = this.maxAcceleration;

      const velocity = clampVelocity({
        minX: h.velocity.minX - a * dt,
        maxX: h.velocity.maxX + a * dt,
        minY: h.velocity.minY - a * dt,
        maxY: h.velocity.maxY + a * dt
      }, this.maxSpeed);

      if (!velocity) return null;

      // Tight conservative displacement bounds under both acceleration and
      // max-speed limits. The old +/- 0.5*a*t^2 formula kept accelerating even
      // after maxSpeed had already been reached, which made long predictions
      // unnecessarily wide.
      const minDx = minDisplacement(h.velocity.minX, dt, a, this.maxSpeed);
      const maxDx = maxDisplacement(h.velocity.maxX, dt, a, this.maxSpeed);
      const minDy = minDisplacement(h.velocity.minY, dt, a, this.maxSpeed);
      const maxDy = maxDisplacement(h.velocity.maxY, dt, a, this.maxSpeed);

      const box = {
        minX: h.box.minX + minDx,
        maxX: h.box.maxX + maxDx,
        minY: h.box.minY + minDy,
        maxY: h.box.maxY + maxDy
      };

      return validBox(box) ? { box, velocity } : null;
    }

    _predictedHypotheses(timeSeconds) {
      if (!this.hypotheses.length || this.observedAt === null) return [];
      const dt = Math.max(0, timeSeconds - this.observedAt);
      return this.hypotheses
        .map(h => {
          const predicted = this._predictHypothesis(h, dt);
          return predicted ? {
            previousBox: copyBox(h.box),
            previousVelocity: copyVelocity(h.velocity),
            box: predicted.box,
            velocity: predicted.velocity
          } : null;
        })
        .filter(Boolean);
    }

    predict(timeSeconds) {
      const error = this._timeError(timeSeconds);
      if (error) return {
        status: error, box: null, regions: [], velocity: null,
        hypotheses: [], hypothesisCount: 0, ageSeconds: null
      };

      this.lastTime = timeSeconds;

      if (!this.hypotheses.length || this.observedAt === null) {
        return {
          status: this.status, box: null, regions: [], velocity: null,
          hypotheses: [], hypothesisCount: 0, ageSeconds: null
        };
      }

      const ageSeconds = timeSeconds - this.observedAt;
      if (ageSeconds >= this.expireAfterSeconds) {
        this.hypotheses = [];
        this.observedAt = null;
        this.status = 'expired';
        return {
          status: 'expired', box: null, regions: [], velocity: null,
          hypotheses: [], hypothesisCount: 0, ageSeconds
        };
      }

      const predicted = this._predictedHypotheses(timeSeconds);
      const regions = uniqueRegions(predicted);
      const velocities = predicted.map(h => h.velocity);

      return {
        status: ageSeconds === 0 ? this.status : 'predicted',
        box: hullOf(regions),
        regions,
        velocity: velocities.length ? {
          minX: Math.min(...velocities.map(v => v.minX)),
          maxX: Math.max(...velocities.map(v => v.maxX)),
          minY: Math.min(...velocities.map(v => v.minY)),
          maxY: Math.max(...velocities.map(v => v.maxY))
        } : null,
        hypotheses: predicted.map(h => ({
          box: copyBox(h.box),
          velocity: copyVelocity(h.velocity)
        })),
        hypothesisCount: predicted.length,
        ageSeconds,
        dt: ageSeconds
      };
    }

    observe(observation, timeSeconds) {
      const error = this._timeError(timeSeconds);
      if (error) return {
        status: error, box: null, regions: [], velocity: null,
        hypotheses: [], hypothesisCount: 0, ageSeconds: null
      };

      if (!validBox(observation)) return {
        status: 'invalid-observation', box: null, regions: [], velocity: null,
        hypotheses: [], hypothesisCount: 0, ageSeconds: null
      };

      this.lastTime = timeSeconds;

      // First reading or reacquisition.
      if (!this.hypotheses.length || this.observedAt === null) {
        this.hypotheses = refineHypotheses(initialHypotheses(observation, this.maxSpeed), MAX_HYPOTHESES);
        this.observedAt = timeSeconds;
        this.status = 'initialized';
        const regions = uniqueRegions(this.hypotheses);
        return {
          status: 'initialized',
          box: hullOf(regions),
          regions,
          velocity: {
            minX: -this.maxSpeed, maxX: this.maxSpeed,
            minY: -this.maxSpeed, maxY: this.maxSpeed
          },
          hypotheses: this.hypotheses.map(copyHypothesis),
          hypothesisCount: this.hypotheses.length,
          ageSeconds: 0,
          previousPrediction: null,
          dt: null,
          velocityStatus: 'velocity-initialized'
        };
      }

      const dt = Math.max(0, timeSeconds - this.observedAt);

      if (dt >= this.expireAfterSeconds) {
        this.hypotheses = refineHypotheses(initialHypotheses(observation, this.maxSpeed), MAX_HYPOTHESES);
        this.observedAt = timeSeconds;
        this.status = 'reacquired';
        const regions = uniqueRegions(this.hypotheses);
        return {
          status: 'reacquired',
          box: hullOf(regions),
          regions,
          velocity: {
            minX: -this.maxSpeed, maxX: this.maxSpeed,
            minY: -this.maxSpeed, maxY: this.maxSpeed
          },
          hypotheses: this.hypotheses.map(copyHypothesis),
          hypothesisCount: this.hypotheses.length,
          ageSeconds: 0,
          previousPrediction: null,
          dt,
          velocityStatus: 'velocity-reinitialized'
        };
      }

      const predicted = this._predictedHypotheses(timeSeconds);
      const predictionRegions = uniqueRegions(predicted);
      const previousPrediction = hullOf(predictionRegions);
      const survivors = [];

      for (const p of predicted) {
        const overlap = intersectBoxes(p.box, observation);
        if (!overlap) continue;

        let velocity = copyVelocity(p.velocity);

        // Narrow velocity only when dt is large enough that division by dt is
        // informative. The displacement constraint is applied independently to
        // each hypothesis, which preserves far more position/velocity
        // correlation than one global interval.
        if (dt >= 0.015) {
          const measuredAverage = {
            minX: (overlap.minX - p.previousBox.maxX) / dt,
            maxX: (overlap.maxX - p.previousBox.minX) / dt,
            minY: (overlap.minY - p.previousBox.maxY) / dt,
            maxY: (overlap.maxY - p.previousBox.minY) / dt
          };

          const displacementVelocity = clampVelocity({
            minX: measuredAverage.minX - this.maxAcceleration * dt,
            maxX: measuredAverage.maxX + this.maxAcceleration * dt,
            minY: measuredAverage.minY - this.maxAcceleration * dt,
            maxY: measuredAverage.maxY + this.maxAcceleration * dt
          }, this.maxSpeed);

          if (displacementVelocity) {
            const narrowed = intersectVelocity(velocity, displacementVelocity);
            if (narrowed) velocity = narrowed;
          }
        }

        survivors.push({ box: overlap, velocity });
      }

      // One weak/noisy observation must not erase the full trajectory set.
      if (!survivors.length) {
        const velocities = predicted.map(h => h.velocity);
        this.status = 'rejected-observation';
        return {
          status: 'rejected-observation',
          box: previousPrediction,
          regions: predictionRegions,
          velocity: velocities.length ? {
            minX: Math.min(...velocities.map(v => v.minX)),
            maxX: Math.max(...velocities.map(v => v.maxX)),
            minY: Math.min(...velocities.map(v => v.minY)),
            maxY: Math.max(...velocities.map(v => v.maxY))
          } : null,
          hypotheses: predicted.map(h => ({
            box: copyBox(h.box),
            velocity: copyVelocity(h.velocity)
          })),
          hypothesisCount: predicted.length,
          ageSeconds: dt,
          previousPrediction,
          previousPredictionRegions: predictionRegions.map(copyBox),
          dt,
          velocityStatus: 'observation-rejected'
        };
      }

      this.hypotheses = refineHypotheses(survivors, MAX_HYPOTHESES);
      this.observedAt = timeSeconds;
      this.status = 'updated';

      const regions = uniqueRegions(this.hypotheses);
      const velocities = this.hypotheses.map(h => h.velocity);

      return {
        status: 'updated',
        box: hullOf(regions),
        regions,
        velocity: {
          minX: Math.min(...velocities.map(v => v.minX)),
          maxX: Math.max(...velocities.map(v => v.maxX)),
          minY: Math.min(...velocities.map(v => v.minY)),
          maxY: Math.max(...velocities.map(v => v.maxY))
        },
        hypotheses: this.hypotheses.map(copyHypothesis),
        hypothesisCount: this.hypotheses.length,
        ageSeconds: 0,
        previousPrediction,
        previousPredictionRegions: predictionRegions.map(copyBox),
        dt,
        velocityStatus: 'hypotheses-narrowed'
      };
    }
  }

  class Estimator {
    constructor(config = {}) {
      this._config = normalizeConfig(config);
      this._region = new HypothesisRegion(this._config);
      this.reset('empty');
    }

    get config() { return { ...this._config }; }

    get snapshot() {
      return {
        status: this._state.status,
        observation: copyBox(this._state.observation),
        prediction: copyBox(this._state.prediction),
        predictedRegions: (this._state.predictedRegions || []).map(copyBox),
        feasible: copyBox(this._state.feasible),
        regions: (this._state.regions || []).map(copyBox),
        velocity: copyVelocity(this._state.velocity),
        currentIntersection: this._stepCount >= 2 ? copyBox(this._state.feasible) : null,
        savedIntersection: copyBox(this._savedIntersection),
        hypothesisCount: this._state.hypothesisCount || 0,
        stepCount: this._stepCount,
        lastStepDt: this._lastStepDt,
        ageSeconds: this._state.ageSeconds,
        velocityStatus: this._state.velocityStatus ?? null,
        maxSpeed: this._config.maxSpeed,
        maxAcceleration: this._config.maxAcceleration,
        sampleIntervalSeconds: this._config.sampleIntervalSeconds,
        expireAfterSeconds: this._config.expireAfterSeconds
      };
    }

    reset(reason = 'reset') {
      this._region.reset(reason);
      this._lastTime = null;
      this._clearSteps();
      this._state = {
        status: reason,
        observation: null,
        prediction: null,
        predictedRegions: [],
        feasible: null,
        regions: [],
        velocity: null,
        hypothesisCount: 0,
        ageSeconds: null,
        velocityStatus: null
      };
      return this.snapshot;
    }

    _clearSteps() {
      this._savedIntersection = null;
      this._acceptedAt = null;
      this._stepCount = 0;
      this._lastStepDt = null;
    }

    configure(patch = {}) {
      const next = normalizeConfig(patch, this._config);
      if (keys.some(key => next[key] !== this._config[key])) {
        this._config = next;
        this._region = new HypothesisRegion(next);
        return this.reset('configuration-reset');
      }
      return this.snapshot;
    }

    update(fit, timeSeconds) {
      if (!finite(timeSeconds)) return this.reset('invalid-time');
      if (this._lastTime !== null && timeSeconds < this._lastTime) {
        return this.reset('non-monotonic-time');
      }

      this._lastTime = timeSeconds;
      const config = this._config;
      const observation = inference.boxFromCursor(
        fit, config.halfWidth, config.halfHeight, config.padding
      );

      const due = this._acceptedAt === null
        || timeSeconds - this._acceptedAt + 1e-9 >= config.sampleIntervalSeconds
        || timeSeconds - this._acceptedAt >= config.expireAfterSeconds;

      if (validBox(observation) && due) {
        const result = this._region.observe(observation, timeSeconds);

        if (result.status === 'rejected-observation') {
          this._state = {
            status: result.status,
            observation: copyBox(observation),
            prediction: copyBox(result.previousPrediction),
            predictedRegions: (result.previousPredictionRegions || []).map(copyBox),
            feasible: copyBox(result.box),
            regions: (result.regions || []).map(copyBox),
            velocity: copyVelocity(result.velocity),
            hypothesisCount: result.hypothesisCount || 0,
            ageSeconds: result.ageSeconds,
            velocityStatus: result.velocityStatus
          };
          return this.snapshot;
        }

        if (result.status === 'initialized' || result.status === 'reacquired') {
          this._clearSteps();
        } else {
          this._lastStepDt = result.dt;
        }

        this._savedIntersection = copyBox(result.box);
        this._acceptedAt = timeSeconds;
        this._stepCount++;

        this._state = {
          status: result.status,
          observation: copyBox(observation),
          prediction: copyBox(result.previousPrediction),
          predictedRegions: (result.previousPredictionRegions || []).map(copyBox),
          feasible: copyBox(result.box),
          regions: (result.regions || []).map(copyBox),
          velocity: copyVelocity(result.velocity),
          hypothesisCount: result.hypothesisCount || 0,
          ageSeconds: result.ageSeconds,
          velocityStatus: result.velocityStatus
        };
      } else {
        const result = this._region.predict(timeSeconds);

        if (!result.box) this._clearSteps();

        this._state = {
          status: result.status,
          observation: result.box ? this._state.observation : null,
          prediction: copyBox(result.box),
          predictedRegions: (result.regions || []).map(copyBox),
          feasible: copyBox(result.box),
          regions: (result.regions || []).map(copyBox),
          velocity: copyVelocity(result.velocity),
          hypothesisCount: result.hypothesisCount || 0,
          ageSeconds: result.ageSeconds,
          velocityStatus: result.box ? 'predicted' : null
        };
      }

      return this.snapshot;
    }
  }

  return {
    Estimator,
    HypothesisRegion,
    DEFAULTS,
    LIMITS,
    normalizeConfig,
    MAX_HYPOTHESES
  };
});


/* One-opponent feasible regions, drawn separately from individual drone shadows. */
(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.DiepPlayerLocator=api;
})(globalThis,function(root){
  'use strict';
  const STORAGE='diep-player-locator-v1';
  const finite=Number.isFinite;
  function worldCursor(fit,projected,rect){
    const b=fit?.bounds;
    if(!fit?.ok||fit.locatorOk===false||!b||![b.minX,b.minY,b.maxX,b.maxY].every(finite)
      ||b.minX>b.maxX||b.minY>b.maxY||!projected||!rect)return null;
    // Cursor fits use local CSS pixels; this is the shared UNCLAMPED projection.
    const a=projected.rawPointer({x:rect.left+b.minX,y:rect.top+b.minY});
    const z=projected.rawPointer({x:rect.left+b.maxX,y:rect.top+b.maxY});
    const p=projected.rawPointer({x:rect.left+fit.x,y:rect.top+fit.y});
    if(![a.x,a.y,z.x,z.y,p.x,p.y].every(finite))return null;
    return {...fit,x:p.x,y:p.y,bounds:{
      minX:Math.min(a.x,z.x),maxX:Math.max(a.x,z.x),
      minY:Math.min(a.y,z.y),maxY:Math.max(a.y,z.y)
    }};
  }
  function selectCursor(analysis,color,ownColor,model,previousFit=null){
    const candidates=[];
    let hasPreview=false;
    for(const group of analysis?.groups||[]){
      const c=model.normalizeColor(group.color);if(!c)continue;
      if(color==='auto'&&ownColor&&model.colorsMatch(c,ownColor))continue;
      if(color!=='auto'&&!model.colorsMatch(c,color))continue;
      hasPreview=hasPreview||!!group.previews?.length;
      const locatorFits=group.locatorFits||(group.fits||(group.fit?.ok?[group.fit]:[])).filter(fit=>fit?.locatorOk!==false);
      for(const fit of locatorFits)if(fit?.ok&&fit.locatorOk!==false)candidates.push({fit,color:c});
    }
    const rawGoodGroups=(analysis?.groups||[]).some(group=>(group.fits||[]).some(fit=>fit?.ok));

    if(candidates.length===1)return {...candidates[0],reason:'observed'};

    // Continuity is only a tie-breaker when several geometrically valid fits
    // exist. A single valid cursor is NEVER speed-limited, so intentional fast
    // cursor sweeps remain usable for narrowing the player region.
    if(candidates.length>1&&previousFit&&[previousFit.x,previousFit.y].every(finite)){
      const ranked=candidates.map(candidate=>({
        ...candidate,
        continuityDistance:Math.hypot(candidate.fit.x-previousFit.x,candidate.fit.y-previousFit.y),
        sameDirection:previousFit.directionMode
          && candidate.fit.directionMode===previousFit.directionMode
      })).sort((a,b)=>{
        // Distance is primary. Direction mode only breaks near-ties; it is not
        // locked because attract/repel behavior can legitimately change.
        const d=a.continuityDistance-b.continuityDistance;
        if(Math.abs(d)>2)return d;
        return Number(b.sameDirection)-Number(a.sameDirection);
      });

      const best=ranked[0],second=ranked[1];
      const decisive=!second
        || best.continuityDistance+8<second.continuityDistance*0.55;

      if(decisive)return {...best,reason:'observed-continuity'};
    }

    return {fit:null,reason:candidates.length?'ambiguous-targets'
      :rawGoodGroups?'cursor-quality-rejected'
      :hasPreview?'uncertain-cursor':'no-cursor'};
  }
  function install({getStatus,getCamera,getOwnColor}={}){
    const doc=root.document,model=root.DroneCursorModel,removers=[];
    const estimator=new root.DiepPlayerRegion.Estimator();
    const config={enabled:false,color:'auto'};
    let canvas=null,rect=null,projected=null,overlay=null,ctx=null,ui=null,destroyed=false;
    let geometry='',lastCamera=null,lastFrame=null,lastUI=-Infinity,analysis=null,targetColor=null,lastCursorFit=null;
    let inputStatus='disabled',picking=false,suppressClick=false;
    try{
      const saved=JSON.parse(root.localStorage.getItem(STORAGE)||'null');
      if(saved?.version===1||saved?.version===2||saved?.version===3||saved?.version===4||saved?.version===5){
        if(typeof saved.enabled==='boolean')config.enabled=saved.enabled;
        const color=model.normalizeColor(saved.color);if(color||saved.color==='auto')config.color=color||'auto';
        estimator.configure({...saved,...(saved.version===1?{expireAfterSeconds:7}:{}),
          ...(saved.version<3?{sampleIntervalSeconds:0}:{}),
          ...(saved.version<4?{maxAcceleration:1000,padding:0}:{}), ...(saved.version===4?{maxAcceleration:1000,padding:0}:{})});
      }
    }catch{}
    function listen(target,name,fn,options){target.addEventListener(name,fn,options);removers.push(()=>target.removeEventListener(name,fn,options));}
    function reset(reason='reset'){
      estimator.reset(typeof reason==='string'?reason:'reset');lastFrame=null;targetColor=null;lastCursorFit=null;
      inputStatus=reason;ctx?.clearRect(0,0,overlay.width,overlay.height);
    }
    function persist(){try{root.localStorage.setItem(STORAGE,JSON.stringify({version:5,...config,...estimator.config}));}catch{}}
    function configure(next={}){
      if(destroyed)return;
      const previous={...config},oldModel=estimator.config;
      if(typeof next.enabled==='boolean')config.enabled=next.enabled;
      if(next.color==='auto')config.color='auto';else{const color=model.normalizeColor(next.color);if(color)config.color=color;}
      estimator.configure(next);
      if(config.enabled!==previous.enabled||config.color!==previous.color
        ||Object.keys(oldModel).some(k=>oldModel[k]!==estimator.config[k]))reset(config.enabled?'configuration-reset':'disabled');
      picking=false;persist();sync();refresh();
    }
    function sync(){
      if(!ui)return;
      for(const [key,value] of Object.entries(estimator.config))ui.querySelector('#position-'+key).value=String(value);
      ui.querySelector('#position-color').value=config.color==='auto'?'#f14e54':config.color;
      ui.querySelector('#position-color-mode').value=config.color==='auto'?'auto':'selected';
    }
    function refresh(){
      if(!ui)return;
      const state=estimator.snapshot;
      ui.querySelector('#position-toggle').textContent='Player locator: '+(config.enabled?'On':'Off');
      ui.querySelector('#position-toggle').setAttribute('aria-pressed',String(config.enabled));
      ui.querySelector('#position-pick').textContent=picking?'Cancel picking':'Pick opponent drones';
      const reason={disabled:'Off. Enable for a one-opponent fight.', 'unsupported-camera':'Waiting for the supported game camera.',
        'ambiguous-targets':'Multiple cursor estimates: predicting only.', 'no-cursor':'No new cursor: predicting only.',
        'cursor-quality-rejected':'Cursor geometry too weak for safe localization: predicting only.',
        'uncertain-cursor':'Cursor distance uncertain: predicting only.',
        observed:'One opponent cursor observed.', 'observed-continuity':'Opponent cursor selected by temporal continuity.', 'geometry-reset':'View changed: waiting for fresh observations.',
        'camera-jump':'Camera jumped: history reset.'}[inputStatus]||String(inputStatus);
      const velocity=state.velocity;
      const velocityText=velocity
        ?` · vx [${Math.round(velocity.minX)}, ${Math.round(velocity.maxX)}] · vy [${Math.round(velocity.minY)}, ${Math.round(velocity.maxY)}]`
        :'';
      const hypothesisText=state.hypothesisCount?` · ${state.hypothesisCount} hypotheses`:'';
      const rejection=state.status==='rejected-observation'?' · latest reading rejected':'';
      ui.querySelector('#position-status').textContent=picking?'Click one of the opponent’s visible drones.'
        :`${reason}${state.feasible?` · step ${state.stepCount} · age ${state.ageSeconds.toFixed(2)} s${state.lastStepDt===null?'':` · last Δt ${Math.round(state.lastStepDt*1000)} ms`}`:state.status==='expired'?' · expired':''}${rejection}${hypothesisText}${velocityText}`;
      ui.querySelector('#position-area').textContent=state.currentIntersection
        ?`Current feasible region: ${Math.round(state.currentIntersection.maxX-state.currentIntersection.minX)} × ${Math.round(state.currentIntersection.maxY-state.currentIntersection.minY)} world units${state.velocityStatus?` · ${state.velocityStatus}`:''}`
        :state.stepCount===1?'First reading saved; waiting for the next reading.':'Waiting for two cursor readings.';
      const settings=estimator.config,b=state.observation;
      ui.querySelector('#position-uncertainty').textContent=b
        ?`Last cursor uncertainty: ${Math.round(Math.max(0,b.maxX-b.minX-2*(settings.halfWidth+settings.padding)))} × ${Math.round(Math.max(0,b.maxY-b.minY-2*(settings.halfHeight+settings.padding)))} world units. View padding adds ${2*settings.padding} units to the ideal edge-to-edge strip width.`
        :'Cursor uncertainty will appear after a reading.';
    }
    function mountControls(parent){
      if(ui||destroyed)return;ui=doc.createElement('div');
      ui.innerHTML=`<div class="row"><button type="button" id="position-toggle" style="width:100%"></button></div>
        <p class="hint" id="position-status" role="status"></p>
        <details><summary style="cursor:pointer">Player locator settings</summary>
        <p class="hint">For one opponent. Regions assume the inferred cursor stays inside their normal view. They show possible positions, not a known tank location.</p>
        <div class="row"><button type="button" id="position-pick">Pick opponent drones</button><button type="button" id="position-reset">Reset history</button></div>
        <label>Opponent color <select id="position-color-mode"><option value="auto">Auto: one group</option><option value="selected">Selected color</option></select> <input id="position-color" type="color" value="#f14e54" style="width:45px;height:25px"></label>
        <p class="hint">Auto skips your selected shadow color. Multiple matching cursor estimates pause observations.</p>
        <label style="display:block;margin-top:8px">Max tank speed <input id="position-maxSpeed" type="number" min="0" max="5000" step="1" style="width:70px"> units/s</label>
        <label style="display:block">Max acceleration <input id="position-maxAcceleration" type="number" min="0" max="20000" step="50" style="width:75px"> units/s²</label>
        <p class="hint">The locator keeps correlated position/velocity hypotheses, dynamically subdivides broad survivors, and integrates acceleration only until max speed is reached. Raise speed/acceleration only if real sharp movement or knockback is being rejected.</p>
        <label style="display:block">Minimum reading interval <input id="position-sampleIntervalSeconds" type="number" min="0" max="1" step="0.01" style="width:65px"> seconds</label>
        <p class="hint">0 uses every fresh captured frame. Good observations narrow both the feasible position and velocity ranges; weak long-range cursor geometry is ignored.</p>
        <label style="display:block">Expire after <input id="position-expireAfterSeconds" type="number" min="0.1" max="60" step="0.1" style="width:65px"> seconds</label>
        <label style="display:block">View/camera padding <input id="position-padding" type="number" min="0" max="5000" step="10" style="width:65px"> units</label>
        <details><summary>Opponent normal view</summary>
        <label>Half-width <input id="position-halfWidth" type="number" min="1" max="20000" step="1" style="width:85px"></label>
        <label>Half-height <input id="position-halfHeight" type="number" min="1" max="20000" step="1" style="width:85px"></label>
        <p class="hint">Defaults follow your 1920×1080 level-45 Overlord view. Your own zoom does not change these values.</p></details>
        <p class="hint" style="color:#97efad">Green outlines = feasible hypothesis union. Blue dotted outlines = predicted hypothesis union; dashed outer boxes are hull guides only. Mirrored/mixed-direction and weak long-range cursor fits are kept out of the locator.</p>
        <p class="hint" id="position-area"></p><p class="hint" id="position-uncertainty"></p></details>`;
      parent.appendChild(ui);
      listen(ui.querySelector('#position-toggle'),'click',()=>configure({enabled:!config.enabled}));
      listen(ui.querySelector('#position-reset'),'click',()=>{reset('explicit-reset');refresh();});
      listen(ui.querySelector('#position-pick'),'click',()=>{picking=!picking;refresh();});
      const color=ui.querySelector('#position-color');
      for(const type of ['input','change'])listen(color,type,()=>configure({color:color.value}));
      listen(ui.querySelector('#position-color-mode'),'change',e=>configure({color:e.target.value==='auto'?'auto':color.value}));
      for(const key of Object.keys(estimator.config))listen(ui.querySelector('#position-'+key),'change',e=>{
        if(e.target.value.trim()===''||e.target.checkValidity?.()===false)return;
        configure({[key]:Number(e.target.value)});
      });
      sync();refresh();
    }
    function drawBox(box,color,dash,width,fill){
      if(!box)return;
      const a=projected.toScreen({x:box.minX,y:box.minY}),b=projected.toScreen({x:box.maxX,y:box.maxY});
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);
      if(fill){ctx.fillStyle=fill;ctx.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);}
      ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
    }
    function render(){
      if(!ctx||!rect)return;
      const dpr=root.devicePixelRatio||1,w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
      if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
      Object.assign(overlay.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
      if(!config.enabled||!projected)return;

      const state=estimator.snapshot;

      // Latest cursor-derived observation is intentionally not drawn.

      // Draw the actual predicted hypothesis UNION in blue. Do not fill the
      // giant hull between disconnected predictions.
      const predictedRegions=state.predictedRegions||[];
      for(const region of predictedRegions){
        drawBox(region,'#66ccff',[2,4],0.9);
      }

      // Current feasible hypothesis union in green.
      const regions=state.regions||[];
      for(const region of regions){
        drawBox(region,'#97efad',[],1.1);
      }

      // Hulls are guides only, not the claimed feasible/predicted set.
      if(state.prediction)drawBox(state.prediction,'#66ccff',[9,6],0.9);
      if(state.feasible)drawBox(state.feasible,'#97efad',[10,5],1.1);

      if(state.feasible){
        ctx.setLineDash([]);ctx.font='12px system-ui';ctx.fillStyle='#97efad';
        const width=Math.max(0,state.feasible.maxX-state.feasible.minX);
        const height=Math.max(0,state.feasible.maxY-state.feasible.minY);
        ctx.fillText(
          `Feasible hypotheses · ${regions.length} regions · hull ${Math.round(width)} × ${Math.round(height)} · ${state.status}`,
          8,34
        );
      }
    }
    function update({canvas:nextCanvas,analysis:nextAnalysis=null,frameId,ms}){
      if(destroyed)return;
      const priorInputStatus=inputStatus;
      try{
        const unavailable=reason=>{
          inputStatus=reason;projected=null;lastCamera=null;analysis=null;
          estimator.update(null,ms/1000);ctx?.clearRect(0,0,overlay.width,overlay.height);refresh();
        };
        const nextRect=nextCanvas?.getBoundingClientRect();
        const nextGeometry=nextCanvas&&nextRect?[nextCanvas.width,nextCanvas.height,nextRect.width,nextRect.height].join(','):'';
        const changed=canvas!==nextCanvas||geometry!==nextGeometry;
        canvas=nextCanvas;rect=nextRect;geometry=nextGeometry;
        if(nextAnalysis)analysis=nextAnalysis;
        if(!config.enabled){reset('disabled');render();refresh();return;}
        if(doc.hidden||!canvas||!rect?.width||!rect?.height){unavailable('unavailable-view');return;}
        const camera=getCamera?.(),fov=getStatus?.();
        projected=root.DiepDroneShadows.projection(canvas,rect,camera,fov);
        if(!projected){unavailable('unsupported-camera');return;}
        let discard=changed;
        if(changed){inputStatus='geometry-reset';analysis=null;}
        if(lastCamera&&finite(ms)&&ms>=lastCamera.ms&&Math.hypot(camera.x-lastCamera.x,camera.y-lastCamera.y)>500+3000*(ms-lastCamera.ms)/1000){
          reset('camera-jump');discard=true;
        }
        lastCamera={x:camera.x,y:camera.y,ms};
        const own=model.normalizeColor(getOwnColor?.());
        if(config.color==='auto'&&own&&targetColor&&model.colorsMatch(own,targetColor))reset('own-color-changed');
        let fit=null;
        if(!discard&&nextAnalysis&&frameId!==lastFrame){
          lastFrame=frameId;
          const chosen=selectCursor(nextAnalysis,config.color,own,model,lastCursorFit);inputStatus=chosen.reason;
          if(chosen.fit){
            if(targetColor&&!model.colorsMatch(targetColor,chosen.color)){reset('target-changed');lastFrame=frameId;}
            targetColor=chosen.color;fit=worldCursor(chosen.fit,projected,rect);
            if(fit)lastCursorFit={x:chosen.fit.x,y:chosen.fit.y,directionMode:chosen.fit.directionMode};
            inputStatus=fit?(chosen.reason==='observed-continuity'?'observed-continuity':'observed'):'invalid-cursor';
          }
        }else if(!discard&&inputStatus==='observed')inputStatus='no-cursor';
        estimator.update(fit,ms/1000);render();
        if(inputStatus!==priorInputStatus||ms-lastUI>=150||!finite(ms)){refresh();lastUI=ms;}
      }catch(error){reset('error');inputStatus='Locator paused: '+error.message;config.enabled=false;refresh();}
    }
    function isCanvasEvent(event){
      const path=event.composedPath?.()||[event.target];
      return canvas&&rect&&!path.some(n=>n?.id==='diep-fov-controls'||['INPUT','TEXTAREA','BUTTON','SELECT','A'].includes(n?.tagName)||n?.isContentEditable)
        &&finite(event.clientX)&&finite(event.clientY)&&event.clientX>=rect.left&&event.clientX<=rect.left+rect.width
        &&event.clientY>=rect.top&&event.clientY<=rect.top+rect.height;
    }
    function consume(e){e.preventDefault();e.stopImmediatePropagation();}
    listen(root,'pointerdown',event=>{
      if(!picking||!isCanvasEvent(event)||event.isPrimary===false)return;
      consume(event);suppressClick=true;
      const x=event.clientX-rect.left,y=event.clientY-rect.top;
      const candidates=(analysis?.groups||[]).flatMap(g=>g.rays.map(r=>({color:g.color,d:Math.hypot(r.x-x,r.y-y)})))
        .filter(p=>p.d<=25).sort((a,b)=>a.d-b.d);
      if(candidates.length)configure({color:candidates[0].color,enabled:true});
      else{inputStatus='No captured drone there. Try a visible triangle.';refresh();}
    },true);
    for(const type of ['mousedown','mouseup','pointerup','click','contextmenu'])listen(root,type,e=>{
      if(suppressClick&&isCanvasEvent(e)){consume(e);if(type==='click'||type==='contextmenu')suppressClick=false;}
    },true);
    listen(root,'blur',()=>{suppressClick=false;analysis=null;});
    listen(doc,'visibilitychange',()=>{analysis=null;lastCamera=null;});
    function boot(){
      if(destroyed)return;overlay=doc.createElement('canvas');overlay.id='diep-player-position';overlay.setAttribute('aria-hidden','true');
      overlay.style.cssText='all:initial;position:fixed;pointer-events:none;z-index:2147483040';
      doc.documentElement.appendChild(overlay);ctx=overlay.getContext('2d');
    }
    if(doc.readyState==='loading')listen(doc,'DOMContentLoaded',boot,{once:true});else boot();
    return {mountControls,configure,update,reset,get enabled(){return config.enabled;},get needsAnalysis(){return config.enabled||picking;},
      get status(){return {...estimator.snapshot,enabled:config.enabled,config:{...config,...estimator.config},inputStatus,targetColor,lastCursorFit,picking};},
      destroy(){if(destroyed)return;destroyed=true;reset('destroyed');removers.forEach(fn=>fn());overlay?.remove();ui?.remove();}};
  }
  return {install,worldCursor,selectCursor};
});


(function (root, factory) {
  'use strict';
  root.DiepDroneCursor = factory(root);
})(globalThis, function (root) {
  'use strict';
  const STORAGE = 'diep-cursor-overlay-v1';
  function install({controller, getCamera} = {}) {
    const doc = root.document, listeners = [];
    let canvas = null, overlay = null, ctx = null, ui = null, raf = null, destroyed = false;
    let enabled = true, latest = null, message = 'Waiting for visible drones.', lastSample = -Infinity;
    let frameId = -1, geometry = '', lastUi = -Infinity;
    const config = {color:'all', mode:'lines', headingVertex:0};
    try {
      const saved = JSON.parse(root.localStorage.getItem(STORAGE) || 'null');
      if (saved && (saved.color === 'all' || /^#[0-9a-f]{6}$/i.test(saved.color))) config.color = saved.color;
      // A full line has no attract/repel direction; discard old steering choices.
      if ([0,1,2].includes(saved?.headingVertex)) config.headingVertex = saved.headingVertex;
    } catch {}
    const capture = root.DroneCapture.install(() => canvas, undefined, {resetOnFrameStart:true});
    const shadows = root.DiepDroneShadows?.install({getStatus:()=>controller?.getStatus(), getCamera});
    const position = root.DiepPlayerLocator?.install({getStatus:()=>controller?.getStatus(),getCamera,
      getOwnColor:()=>shadows?.status.config.color});
    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      listeners.push(() => target.removeEventListener(type, fn, options));
    }
    function reset(reason='reset',resetPosition=true) { latest = null; capture.clear(); lastSample = -Infinity;
      if(resetPosition)position?.reset(reason); }
    function setEnabled(value) {
      if (destroyed) return;
      enabled = !!value; reset('cursor-toggle',false);
      message = enabled ? 'Waiting for visible drones.' : 'Cursor rays paused.';
      if (overlay) overlay.style.display = enabled ? 'block' : 'none';
      refreshUI();
    }
    function configure(next) {
      if (destroyed) return;
      const previousCorner=config.headingVertex;
      if (next.color === 'all' || /^#[0-9a-f]{6}$/i.test(next.color)) config.color = next.color.toLowerCase();
      if ([0,1,2].includes(next.headingVertex)) config.headingVertex = next.headingVertex;
      try { root.localStorage.setItem(STORAGE, JSON.stringify({...config,version:3})); } catch {}
      reset('heading-changed',previousCorner!==config.headingVertex); message=enabled?'Waiting for fresh drone headings.':'Cursor rays paused.';
      syncConfigUI(); refreshUI();
    }
    function syncConfigUI() {
      if(!ui)return;
      ui.querySelector('#cursor-color-mode').value=config.color==='all'?'all':'selected';
      if(config.color!=='all')ui.querySelector('#cursor-color').value=config.color;
      ui.querySelector('#cursor-corner').value=String(config.headingVertex);
    }
    function refreshUI() {
      if (!ui) return;
      ui.querySelector('#cursor-toggle').textContent = enabled ? 'Cursor rays: On · Alt+C' : 'Cursor rays: Off · Alt+C';
      ui.querySelector('#cursor-toggle').setAttribute('aria-pressed', String(enabled));
      ui.querySelector('#cursor-status').textContent = message;
    }
    function mountControls(parent) {
      if (destroyed || ui) return;
      ui = doc.createElement('div');
      ui.innerHTML = `<div class="row"><button id="cursor-toggle" type="button" style="width:100%"></button></div>
        <p id="cursor-status" class="hint" role="status"></p>
        <details style="margin-top:8px"><summary style="cursor:pointer">Drone cursor settings</summary>
        <label style="display:block;margin-top:8px">Drone colors <select id="cursor-color-mode"><option value="all">All detected</option><option value="selected">Selected color</option></select></label>
        <label style="display:block;margin-top:8px">Selected color <input id="cursor-color" type="color" value="#6016ff" style="width:50px;height:25px;vertical-align:middle"></label>
        <label style="display:block;margin-top:8px">Front corner <select id="cursor-corner"><option value="0">First</option><option value="1">Second</option><option value="2">Third</option></select></label>
        <p class="hint">Cyan lines extend through each drone's front corner and centre in both directions. Shared intersections estimate a cursor, regardless of attract or repel. A dashed marker shows an immediate crossing whose distance is still uncertain; it does not narrow the green region. Separate groups can show separate targets. Two-drone estimates are tentative. Check the front corner against your own drones while aiming steadily.</p></details>`;
      parent.appendChild(ui);
      const colorMode = ui.querySelector('#cursor-color-mode'), color = ui.querySelector('#cursor-color');
      const corner = ui.querySelector('#cursor-corner');
      syncConfigUI();
      listen(ui.querySelector('#cursor-toggle'), 'click', () => setEnabled(!enabled));
      listen(colorMode, 'change', () => configure({color:colorMode.value === 'all' ? 'all' : color.value}));
      listen(color, 'change', () => { colorMode.value = 'selected'; configure({color:color.value}); });
      listen(corner, 'change', () => configure({headingVertex:Number(corner.value)}));
      position?.mountControls(parent);
      shadows?.mountControls(parent);
      refreshUI();
    }
    function label(text, x, y, width, height) {
      const size = ctx.measureText(text).width + 10;
      x = Math.max(3, Math.min(width - size - 3, x));
      y = Math.max(18, Math.min(height - 5, y));
      ctx.fillStyle = '#09252ee6'; ctx.fillRect(x, y - 14, size, 19);
      ctx.fillStyle = '#a6ffff'; ctx.fillText(text, x + 5, y);
    }
    function draw(width, height) {
      ctx.clearRect(0,0,width,height);
      if (!latest) return;
      ctx.font = '12px system-ui,sans-serif'; ctx.lineWidth = 1.3;
      for (const group of latest.groups) {
        const fits=group.fits || (group.fit.ok?[group.fit]:[]);
        for (let i=0;i<group.rays.length;i++) {
          const ray = group.rays[i];
          const start = root.DroneCursorModel.rayToEdge(ray,width,height,'reverse');
          const end = root.DroneCursorModel.rayToEdge(ray,width,height,'forward');
          if(start && end){
            ctx.strokeStyle='#72f4f090';
            ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();
          }
          ctx.fillStyle='#a6ffff';ctx.beginPath();ctx.arc(ray.x,ray.y,2.5,0,Math.PI*2);ctx.fill();
        }
        ctx.setLineDash([]);
        for(const point of (group.intersections || []).slice(0,80)){
          ctx.fillStyle='#a6ffff70';
          ctx.beginPath();ctx.arc(point.x,point.y,3,0,Math.PI*2);ctx.fill();
        }
        for(const fit of [...fits,...(group.previews||[])]){
        const provisional=fit.provisional===true;
        if(!provisional){
          ctx.fillStyle = '#6fe7eb18'; ctx.strokeStyle = '#6fe7eb66';
          ctx.beginPath(); fit.polygon.forEach((p,i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y));
          ctx.closePath();ctx.fill();ctx.stroke();
        }
        const offscreen = fit.x<10 || fit.y<10 || fit.x>width-10 || fit.y>height-10;
        let x=fit.x,y=fit.y;
        if (offscreen) {
          const dx=x-width/2,dy=y-height/2;
          const ratio=Math.min((width/2-14)/Math.max(Math.abs(dx),1e-9),(height/2-14)/Math.max(Math.abs(dy),1e-9));
          x=width/2+dx*ratio;y=height/2+dy*ratio;
        }
        ctx.strokeStyle = '#a6ffff';ctx.lineWidth=2;
        ctx.setLineDash(provisional?[4,3]:[]);
        ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.moveTo(x-12,y);ctx.lineTo(x+12,y);ctx.moveTo(x,y-12);ctx.lineTo(x,y+12);ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = group.color;ctx.fillRect(x-2,y-2,4,4);
        label(provisional ? `Cursor crossing${offscreen?' off screen':''} · range uncertain`
          :offscreen ? 'Cursor estimate off screen' : `Cursor estimate · ${fit.inlierCount} drones${fit.inlierCount===2?' · tentative':''}`,x+14,y-14,width,height);
        ctx.lineWidth=1.3;
        }
      }
    }
    function tick(ms) {
      if (destroyed) return;
      const priorMessage=message;
      try {
        const next = doc.getElementById('canvas');
        if (next !== canvas) {canvas=next?.tagName?.toLowerCase()==='canvas'?next:null;reset('canvas-changed',false);geometry='';}
        const samples = capture.drain(), currentFrame = capture.frameId;
        const rect = canvas?.getBoundingClientRect();
        shadows?.update({canvas, samples, frameId:currentFrame, ms, headingVertex:config.headingVertex});
        let freshAnalysis=null;
        if ((!enabled&&!position?.needsAnalysis) || doc.hidden || !rect || rect.width<=0 || rect.height<=0 || !canvas.width || !canvas.height) {
          latest=null;overlay.style.display='none';
          if(enabled)message='Waiting for the game canvas.';
        } else {
          overlay.style.display=enabled?'block':'none';
          Object.assign(overlay.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
          const nextGeometry=[rect.left,rect.top,rect.width,rect.height,canvas.width,canvas.height].join(',');
          if(nextGeometry!==geometry){latest=null;geometry=nextGeometry;}
          const dpr=root.devicePixelRatio||1,w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
          if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
          ctx.setTransform(dpr,0,0,dpr,0,0);
          // Fit every fresh draw, including brief edge/corner targets. The frame
          // guard prevents reusing an observation when the game has not drawn.
          if (samples.length && currentFrame!==frameId) {
            freshAnalysis=root.DroneCursorModel.analyze(samples,{left:rect.left,top:rect.top,width:rect.width,height:rect.height,pixelWidth:canvas.width,pixelHeight:canvas.height},
              position?.needsAnalysis?{...config,color:'all'}:config);
            latest=position?.needsAnalysis&&config.color!=='all'?{...freshAnalysis,groups:freshAnalysis.groups.filter(g=>root.DroneCursorModel.colorsMatch(g.color,config.color))}:freshAnalysis;
            lastSample=ms;
            const fits=latest.groups.flatMap(group=>group.fits|| (group.fit.ok?[group.fit]:[]));
            const previews=latest.groups.reduce((n,g)=>n+(g.previews?.length||0),0);
            const detected=latest.groups.reduce((n,g)=>n+g.rays.length,0);
            const crossings=latest.groups.reduce((n,g)=>n+(g.intersections?.length||0),0);
            message=fits.length||previews ? [`Detected ${detected} drones`,
              fits.length?`${fits.length} cursor estimate${fits.length===1?'':'s'}`:null,
              previews?`${previews} crossing${previews===1?'':'s'} · range uncertain`:null].filter(Boolean).join(' · ')
              : detected ? `Detected ${detected} drone${detected===1?'':'s'} · ${crossings} line crossings${detected===1?' · need one more':''}`
              : `${samples.length} triangle fills captured · none match the color/size filter.`;
          } else if ((!samples.length && currentFrame!==frameId) || ms-lastSample>100) {
            latest=null;message='Detected 0 drones · waiting for triangle paths.';
          }
          if(enabled)draw(rect.width,rect.height);
        }
        position?.update({canvas,analysis:freshAnalysis,frameId:currentFrame,ms});
        if(!enabled)message='Cursor rays paused.';
        frameId=currentFrame;
        if(message!==priorMessage||ms-lastUi>=150){refreshUI();lastUi=ms;}
      } catch(error) {setEnabled(false);message=`Cursor overlay paused: ${error.message}`;refreshUI();}
      raf=root.requestAnimationFrame(tick);
    }
    function boot() {
      if(destroyed)return;
      overlay=doc.createElement('canvas');overlay.id='diep-cursor-overlay';overlay.setAttribute('aria-hidden','true');
      overlay.style.cssText='all:initial;position:fixed;display:none;pointer-events:none;z-index:2147483050';
      doc.documentElement.appendChild(overlay);ctx=overlay.getContext('2d');raf=root.requestAnimationFrame(tick);
    }
    listen(root,'keydown',event=>{
      if(!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.repeat||event.code!=='KeyC')return;
      const path=event.composedPath?.()||[event.target];
      if(path.some(node=>['INPUT','TEXTAREA','SELECT'].includes(node?.tagName)||node?.isContentEditable||node?.getAttribute?.('role')==='textbox'))return;
      const modal=doc.querySelector('dialog[open], [aria-modal="true"]:not([aria-hidden="true"]):not([hidden])');
      if(modal&&modal.getClientRects().length)return;
      event.preventDefault();event.stopImmediatePropagation();setEnabled(!enabled);
    },true);
    listen(doc,'visibilitychange',()=>reset('visibility-reset',false));
    listen(root,'resize',()=>reset('geometry-reset',false));
    if(doc.readyState==='loading')listen(doc,'DOMContentLoaded',boot,{once:true});else boot();
    return {mountControls,setEnabled,configure,shadows,position,reset:()=>reset('explicit-reset'),
      get status(){return {enabled,message,config:{...config},capture:capture.stats,result:latest,position:position?.status};},
      destroy(){if(destroyed)return;destroyed=true;root.cancelAnimationFrame(raf);position?.destroy();shadows?.destroy();capture.uninstall();listeners.forEach(remove=>remove());overlay?.remove();ui?.remove();}
    };
  }
  return {install};
});


(function () {
  'use strict';
  if(window.diepFovEditor)return;
  const controller=DiepFovController.create();
  const records=new WeakMap();
  let attached=false,destroyed=false,clientHash=null,cameraInstance=null;
  function record(token) { if(!records.has(token))records.set(token,{}); return records.get(token); }
  const loader=DiepFovLoader.install({
    async prepare(bytes,token) {
      // Other small WASM modules on the page need no analysis.
      if(bytes.length<1000000)return null;
      if(!attached)controller.setStatus('waiting','Checking the game client…');
      const result=await DiepFovWasm.prepareWasm(bytes);
      Object.assign(record(token),result,{bytes:undefined});
      if(destroyed)return null;
      if(!result.patched&&!attached)controller.setStatus('unsupported',`${result.reason}. This game build needs an updated camera profile.`);
      return result.patched?result.bytes:null;
    },
    onInstance(instance,token) {
      const r=record(token),handle=instance?.exports?.[DiepFovWasm.EXPORT_NAME];
      if(destroyed||!r.patched||!handle)return;
      clientHash=r.sha256;
      cameraInstance=instance;
      controller.attach(handle); attached=true;
    },
    onError(error) {
      if(!attached&&!destroyed)controller.setStatus('error',`Camera patch unavailable: ${error.message}. The original game can still load.`);
    }
  });
  const cursor=DiepDroneCursor.install({controller,
    getCamera:()=>DiepShadowCamera.readCamera(cameraInstance,clientHash)});
  const controls=DiepFovControls.install(controller,cursor);
  const outline=DiepFovOutline.install(controller);
  function unload() { controller.setEnabled(false); }
  window.addEventListener('pagehide',unload);
  window.diepFovEditor={
    get status() { return {...controller.getStatus(),clientHash,panelVisible:controls.panelVisible,position:cursor.position?.status}; },
    setEnabled:controller.setEnabled,
    setMultiplier:controller.setMultiplier,
    setPanelVisible:controls.setPanelVisible,
    cursor,
    position:cursor.position,
    destroy() {
      if(destroyed)return; destroyed=true;
      cursor.destroy(); outline.destroy(); controls.destroy(); controller.destroy(); loader.uninstall();
      cameraInstance=null;
      window.removeEventListener('pagehide',unload);
      delete window.diepFovEditor;
    }
  };
})();

