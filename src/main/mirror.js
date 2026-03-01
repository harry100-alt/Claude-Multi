const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findClaude, getClaudeVersion } = require('./claude-finder');
const { MIRROR_DIR, APP_DATA_DIR, loadConfig, saveConfig, ensureDir } = require('./config');
const { makeLink, IS_WIN } = require('./platform');

/**
 * Ensure the mirror directory exists and is up-to-date.
 * Returns { ok, error? }
 */
async function ensureMirror() {
  const claude = findClaude();
  if (!claude) {
    return { ok: false, error: 'Claude Desktop not found. Install it first.' };
  }

  const mirrorExe = path.join(MIRROR_DIR, path.basename(claude.exe));
  const config = loadConfig();
  const currentVersion = getClaudeVersion();

  // Check if mirror exists and version matches
  if (fs.existsSync(mirrorExe) && config.patchedClaudeVersion === currentVersion) {
    return { ok: true };
  }

  // Need to create or rebuild mirror
  return createMirror(claude, currentVersion);
}

async function createMirror(claude, version) {
  try {
    // Clean up existing mirror
    if (fs.existsSync(MIRROR_DIR)) {
      cleanMirrorDir(MIRROR_DIR);
    }

    ensureDir(MIRROR_DIR);
    const mirrorResources = path.join(MIRROR_DIR, 'resources');
    ensureDir(mirrorResources);

    // Copy files, junction/symlink directories from Claude app dir
    for (const item of fs.readdirSync(claude.appDir)) {
      if (item === 'resources') continue;
      const src = path.join(claude.appDir, item);
      const dest = path.join(MIRROR_DIR, item);
      const stat = fs.statSync(src);

      if (stat.isDirectory()) {
        makeLink(dest, src);
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    // Patch and install asar
    const patchResult = await patchAsar(claude.resourcesDir, mirrorResources);
    if (!patchResult.ok) return patchResult;

    // Junction app.asar.unpacked
    const unpackedSrc = path.join(claude.resourcesDir, 'app.asar.unpacked');
    const unpackedDest = path.join(mirrorResources, 'app.asar.unpacked');
    if (fs.existsSync(unpackedSrc)) {
      makeLink(unpackedDest, unpackedSrc);
    }

    // Copy/junction remaining resources
    for (const item of fs.readdirSync(claude.resourcesDir)) {
      if (item === 'app.asar' || item === 'app.asar.unpacked') continue;
      const src = path.join(claude.resourcesDir, item);
      const dest = path.join(mirrorResources, item);
      if (fs.existsSync(dest)) continue;
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        makeLink(dest, src);
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    // Disable asar integrity fuse
    disableAsarFuse(path.join(MIRROR_DIR, path.basename(claude.exe)));

    // Save patched version
    const config = loadConfig();
    config.patchedClaudeVersion = version;
    saveConfig(config);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Mirror creation failed: ${err.message}` };
  }
}

/**
 * Extract app.asar, apply patches, repack.
 */
async function patchAsar(sourceResourcesDir, destResourcesDir) {
  const asar = require('@electron/asar');
  const sourceAsar = path.join(sourceResourcesDir, 'app.asar');
  const extractDir = path.join(APP_DATA_DIR, 'asar-extracted');
  const destAsar = path.join(destResourcesDir, 'app.asar');

  try {
    // Clean extraction dir
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }

    // Extract
    asar.extractAll(sourceAsar, extractDir);

    // Find and patch index.js
    const indexJs = path.join(extractDir, '.vite', 'build', 'index.js');
    if (!fs.existsSync(indexJs)) {
      return { ok: false, error: 'Could not find .vite/build/index.js in asar' };
    }

    let code = fs.readFileSync(indexJs, 'utf-8');
    const originalLen = code.length;

    // PATCH 1: Remove single-instance lock
    const oldLock = 'Ce.app.requestSingleInstanceLock()?Ce.app.on("second-instance",(e,r,n)=>{if(co())return;lt&&!lt.isDestroyed()&&(lt.isVisible()||lt.show(),lt.isMinimized()&&lt.restore(),lt.focus());const i=d3t(r);i&&YT(i)}):Ce.app.quit()';
    if (code.includes(oldLock)) {
      code = code.replace(oldLock, 'true/*multi-instance-patch:lock-removed*/');
    } else {
      // Try generic pattern — the variable names may change between versions
      const lockPattern = /\w+\.app\.requestSingleInstanceLock\(\)\?\w+\.app\.on\("second-instance"[^)]+\)\):\w+\.app\.quit\(\)/;
      if (lockPattern.test(code)) {
        code = code.replace(lockPattern, 'true/*multi-instance-patch:lock-removed*/');
      } else {
        return { ok: false, error: 'PATCH 1 FAILED: Could not find single-instance lock code. Claude may have updated.' };
      }
    }

    // PATCH 2: Remove ready handler lock check
    const oldReadyLock = '!Ce.app.requestSingleInstanceLock()';
    if (code.includes(oldReadyLock)) {
      code = code.replace(oldReadyLock, '!true/*multi-instance-patch:ready-lock-removed*/');
    } else {
      // Try generic
      const readyPattern = /!\w+\.app\.requestSingleInstanceLock\(\)/;
      if (readyPattern.test(code)) {
        code = code.replace(readyPattern, '!true/*multi-instance-patch:ready-lock-removed*/');
      }
      // Not fatal if missing
    }

    // PATCH 3: Force MSIX detection
    const oldFs = 'function Fs(){return Ln?Ev!==void 0?Ev:process.windowsStore?(Zk="windowsStore",Ev=!0,!0):kAe()?(Zk="appPath",Ev=!0,!0):(Zk=null,Ev=!1,!1):!1}';
    if (code.includes(oldFs)) {
      code = code.replace(oldFs, 'function Fs(){return Ev=!0,Zk="patched",!0}');
    } else {
      // Try generic — function that checks windowsStore and returns bool
      const fsPattern = /function Fs\(\)\{return \w+\?\w+!==void 0\?\w+:process\.windowsStore[^}]+\}/;
      if (fsPattern.test(code)) {
        code = code.replace(fsPattern, 'function Fs(){return true/*multi-instance-patch:msix*/}');
      } else {
        return { ok: false, error: 'PATCH 3 FAILED: Could not find MSIX detection function. Claude may have updated.' };
      }
    }

    // PATCH 4: Force CCD support
    const oldEdt = 'function EDt(){return process.platform!=="darwin"?{status:"unavailable"}:{status:"supported"}}';
    if (code.includes(oldEdt)) {
      code = code.replace(oldEdt, 'function EDt(){return{status:"supported"}/*multi-instance-patch:code-enabled*/}');
    }
    // Not fatal if missing

    // PATCH 5: Session locking at CLI spawn point
    const oldSpawn = 'Y={command:q,args:W,cwd:i,env:l,signal:this.abortController.signal};if(this.options.spawnClaudeCodeProcess)';
    const lockCheck = 'Y={command:q,args:W,cwd:i,env:l,signal:this.abortController.signal};' +
      '(function(){' +
      'var _fs=require("fs"),_p=require("path"),' +
      '_ld=_p.join(process.env.APPDATA||process.env.HOME||"","Claude-Multi","session-locks");' +
      'try{_fs.mkdirSync(_ld,{recursive:!0})}catch(_e){}' +
      'var _ri=W.indexOf("--resume");' +
      'if(_ri>=0){' +
      'var _sid=W[_ri+1],_lf=_p.join(_ld,_sid+".lock");' +
      'if(_fs.existsSync(_lf)){' +
      'try{' +
      'var _d=JSON.parse(_fs.readFileSync(_lf,"utf-8"));' +
      'if(_d.pid!==process.pid){' +
      'try{' +
      'process.kill(_d.pid,0);' +
      'require("electron").dialog.showErrorBox(' +
      '"Session Conflict",' +
      '"This session is already open in another instance (PID "+_d.pid+"). Close it there first."' +
      ');' +
      'throw new Error("session_locked")' +
      '}catch(_e2){' +
      'if(_e2.message==="session_locked")throw _e2' +
      '}' +
      '}' +
      '}catch(_e){' +
      'if(_e.message==="session_locked")throw _e' +
      '}' +
      '}' +
      '_fs.writeFileSync(_lf,JSON.stringify({pid:process.pid,ts:Date.now()}))' +
      '}' +
      '})();' +
      'if(this.options.spawnClaudeCodeProcess)';

    if (code.includes(oldSpawn)) {
      code = code.replace(oldSpawn, lockCheck);
    } else {
      // Not fatal — session locking is defense in depth
    }

    // Write patched file
    fs.writeFileSync(indexJs, code, 'utf-8');

    // Repack asar
    await asar.createPackage(extractDir, destAsar);

    // Clean up extraction dir
    fs.rmSync(extractDir, { recursive: true, force: true });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Asar patching failed: ${err.message}` };
  }
}

function disableAsarFuse(exePath) {
  try {
    execSync(
      `npx @electron/fuses write --app "${exePath}" EnableEmbeddedAsarIntegrityValidation=off`,
      { encoding: 'utf-8', windowsHide: true, timeout: 30000, stdio: 'pipe' }
    );
  } catch {
    // Non-fatal — some versions don't have the fuse
  }
}

function cleanMirrorDir(dir) {
  // Remove junctions/symlinks first, then delete
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink() || (IS_WIN && stat.isDirectory())) {
          if (IS_WIN) {
            execSync(`cmd /c rmdir "${full}"`, { windowsHide: true, stdio: 'ignore' });
          } else {
            fs.unlinkSync(full);
          }
        }
      } catch {}
    }
    // Handle resources subdirectory
    const resDir = path.join(dir, 'resources');
    if (fs.existsSync(resDir)) {
      for (const item of fs.readdirSync(resDir)) {
        const full = path.join(resDir, item);
        if (IS_WIN) {
          try { execSync(`cmd /c rmdir "${full}"`, { windowsHide: true, stdio: 'ignore' }); } catch {}
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

module.exports = { ensureMirror };
