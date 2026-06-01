// =====================================================================
// Embed bridge (Triad-Coding fork modification, BSD-3-Clause)
//
// Lets the parent window (your education platform at EMBED_PARENT_ORIGIN)
// drive project load/save over window.postMessage, instead of the user's
// local disk. Attached via GUI's onVmInit so it uses the SAME VM instance
// the editor renders.
//
// Protocol
//   parent -> editor:
//     { type: 'scratch:load',         id?, payload: ArrayBuffer }  // .sb3 bytes
//     { type: 'scratch:save-request', id? }
//   editor -> parent:
//     { type: 'scratch:ready' }
//     { type: 'scratch:loaded', id? }
//     { type: 'scratch:saved',  id?, payload: ArrayBuffer }        // .sb3 bytes
//     { type: 'scratch:error',  id?, error: string }
// =====================================================================

// Replaced at build time by webpack DefinePlugin (see webpack.config.js).
const PARENT_ORIGIN = process.env.EMBED_PARENT_ORIGIN;

// Trust only messages from the parent frame AND the expected origin.
const isTrustedParent = event =>
    event.origin === PARENT_ORIGIN && event.source === window.parent;

export default function attachEmbedBridge (vm) {
    const post = (msg, transfer) =>
        window.parent.postMessage(msg, PARENT_ORIGIN, transfer);

    window.addEventListener('message', async event => {
        if (!isTrustedParent(event)) return;                 // origin + source check
        const data = event.data;
        if (!data || typeof data.type !== 'string') return;  // shape check

        try {
            switch (data.type) {
            case 'scratch:load':
                // data.payload is an ArrayBuffer of an .sb3 file.
                await vm.loadProject(data.payload);
                post({type: 'scratch:loaded', id: data.id});
                break;

            case 'scratch:save-request': {
                const blob = await vm.saveProjectSb3();      // Promise<Blob>
                const buffer = await blob.arrayBuffer();
                // Transfer the buffer to avoid copying large projects.
                post({type: 'scratch:saved', id: data.id, payload: buffer}, [buffer]);
                break;
            }

            default:
                break;
            }
        } catch (e) {
            post({type: 'scratch:error', id: data && data.id, error: String(e)});
        }
    });

    // Announce readiness so the parent knows it can send the initial project.
    post({type: 'scratch:ready'});
}
