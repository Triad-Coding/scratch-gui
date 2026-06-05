// =====================================================================
// Embed bridge (Triad-Coding fork modification, BSD-3-Clause)
//
// Lets the parent window (your education platform at EMBED_PARENT_ORIGIN)
// drive project load/save over window.postMessage, instead of the user's
// local disk. Attached via GUI's onVmInit so it uses the SAME VM instance
// the editor renders.
//
// Autosave model: the editor watches the VM for edits and pushes the project
// to the parent, which owns the network. To minimize bytes, the small, often-
// changed project.json is sent on its own; assets (costumes/sounds) are
// content-addressed and sent once, never resent. Saves are debounced (with a
// max-wait) and also flushed when the tab is hidden/closed.
//
// Protocol
//   parent -> editor:
//     { type: 'scratch:load',          id?, payload: ArrayBuffer }   // .sb3 bytes
//     { type: 'scratch:no-project' }                                 // nothing saved yet
//     { type: 'scratch:flush-request' }                              // save now (button/backstop)
//     { type: 'scratch:save-ack',      savedAssets: string[] }       // assets now stored
//   editor -> parent:
//     { type: 'scratch:ready' }
//     { type: 'scratch:loaded',  id? }
//     { type: 'scratch:dirty',   dirty: true }                       // first edit since save
//     { type: 'scratch:autosave', json: string, assets: Asset[] }    // Asset = {md5ext,dataFormat,data}
//     { type: 'scratch:error',   id?, error: string }
// =====================================================================

import debounce from 'lodash.debounce';

// Replaced at build time by webpack DefinePlugin (see webpack.config.js).
const PARENT_ORIGIN = process.env.EMBED_PARENT_ORIGIN;

// Save when the user pauses editing, but never wait longer than the max while
// they keep going — so long, continuous editing still checkpoints.
const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 20000;

// Trust only messages from the parent frame AND the expected origin.
const isTrustedParent = event =>
    event.origin === PARENT_ORIGIN && event.source === window.parent;

/**
 * Attach the parent-window load/save + autosave bridge to the editor's VM.
 * @param {object} vm - the VirtualMachine instance (provided by GUI onVmInit).
 * @returns {void}
 */
export default function attachEmbedBridge (vm) {
    const post = (msg, transfer) =>
        window.parent.postMessage(msg, PARENT_ORIGIN, transfer);

    // armed: only autosave after the initial project state is settled, so we
    // never persist the default project over a student's real (still-loading)
    // one, and never treat deserialization as a user edit.
    let armed = false;
    let loading = false;
    let dirty = false; // has unflushed editor changes (handed to parent on flush)

    // md5exts known to be stored in our backend, so they aren't re-uploaded.
    // Seeded from a loaded project (those assets came from the backend); left
    // empty for a fresh project so its default assets upload once on first save.
    const uploaded = new Set();

    const assets = () => vm.assets || [];
    const md5extOf = a => `${a.assetId}.${a.dataFormat}`;
    const markAllUploaded = () => {
        for (const a of assets()) uploaded.add(md5extOf(a));
    };
    const dirtyAssets = () =>
        assets()
            .filter(a => !uploaded.has(md5extOf(a)))
            .map(a => ({md5ext: md5extOf(a), dataFormat: a.dataFormat, data: a.data}));

    // Hand the current project to the parent. project.json is always sent;
    // not-yet-stored assets ride along (usually none, for a code-only edit).
    const flush = () => {
        if (!armed) return;
        post({type: 'scratch:autosave', json: vm.toJSON(), assets: dirtyAssets()});
        dirty = false; // handed off; further edits re-dirty
    };

    const debouncedFlush = debounce(flush, DEBOUNCE_MS, {maxWait: MAX_WAIT_MS});
    const flushNow = () => {
        debouncedFlush.cancel();
        flush();
    };

    const onProjectChanged = () => {
        if (!armed || loading) return;
        if (!dirty) {
            dirty = true;
            post({type: 'scratch:dirty', dirty: true}); // immediate "unsaved" signal
        }
        debouncedFlush();
    };
    vm.on('PROJECT_CHANGED', onProjectChanged);

    window.addEventListener('message', async event => {
        if (!isTrustedParent(event)) return; // origin + source check
        const data = event.data;
        if (!data || typeof data.type !== 'string') return; // shape check

        try {
            switch (data.type) {
            case 'scratch:load':
                // data.payload is an ArrayBuffer of an .sb3 file. Its assets came
                // from our backend, so mark them stored (no need to re-upload).
                loading = true;
                await vm.loadProject(data.payload);
                markAllUploaded();
                loading = false;
                dirty = false;
                armed = true;
                post({type: 'scratch:loaded', id: data.id});
                break;

            case 'scratch:no-project':
                // Fresh/default project: leave `uploaded` empty so the default
                // assets upload once on the first save. Arm so edits autosave.
                armed = true;
                break;

            case 'scratch:flush-request':
                // Manual Save / parent backstop: persist current state now.
                if (armed) flushNow();
                break;

            case 'scratch:save-ack':
                for (const md5ext of data.savedAssets || []) uploaded.add(md5ext);
                break;

            default:
                break;
            }
        } catch (e) {
            loading = false;
            post({type: 'scratch:error', id: data && data.id, error: String(e)});
        }
    });

    // Best-effort save when the editor is hidden/closed: vm.toJSON() is sync, so
    // we can hand the freshest code to the parent before teardown. We skip this
    // when there are not-yet-stored assets, since the json would reference an
    // asset the backend doesn't have; the normal debounced flush handles those.
    const flushOnHide = () => {
        if (!armed || !dirty || dirtyAssets().length > 0) return;
        post({type: 'scratch:autosave', json: vm.toJSON(), assets: []});
        dirty = false;
    };
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide();
    });

    // Announce readiness so the parent knows it can send the initial project.
    post({type: 'scratch:ready'});
}
