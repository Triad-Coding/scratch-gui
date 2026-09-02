// =====================================================================
// Embed bridge (Triad-Coding fork modification, BSD-3-Clause)
//
// Lets the parent window (your education platform at EMBED_PARENT_ORIGIN)
// drive project load/save over window.postMessage, instead of the user's
// local disk. Attached via AppStateHOC's onStoreInit so it has the SAME Redux
// store (and thus the SAME VM instance) the editor renders.
//
// The parent also drives two editor toggles that we lifted out of the (removed)
// menu bar into the parent's lesson navbar: Turbo Mode and Color Mode (theme).
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
//     { type: 'scratch:set-turbo',     value: boolean }              // toggle Turbo Mode
//     { type: 'scratch:set-theme',     value: 'default'|'high-contrast' } // Color Mode
//     { type: 'scratch:set-feature-config', config: {costumesTab, soundsTab,
//                                                     addExtension, addSprite,
//                                                     addBackdrop} }     // hide editor UI
//                                                     // (each bool; omitted = shown)
//     { type: 'scratch:highlight-block', opcode: string }             // outline one palette
//                                                     // block, e.g. 'motion_movesteps',
//                                                     // and scroll it into view. Sent when a
//                                                     // student clicks a block named inline in
//                                                     // the lesson instructions. An opcode, not
//                                                     // a block id: most palette blocks have a
//                                                     // generated id. Unknown or currently-
//                                                     // absent opcodes no-op silently — a
//                                                     // disabled category means the block
//                                                     // really is not there.
//     { type: 'scratch:set-tab',       tab: 'code'|'costumes'|'sounds' } // switch tabs. Sent
//                                                     // before a highlight whose palette is not
//                                                     // on screen. A tab the feature config has
//                                                     // hidden is refused.
//   editor -> parent:
//     { type: 'scratch:ready' }
//     { type: 'scratch:loaded',  id? }
//     { type: 'scratch:dirty',   dirty: true }                       // first edit since save
//     { type: 'scratch:autosave', json: string, assets: Asset[] }    // Asset = {md5ext,dataFormat,data}
//     { type: 'scratch:error',   id?, error: string }
//     { type: 'scratch:state',   turbo: boolean, theme: string }     // initial + after each toggle
//     { type: 'scratch:tab-changed', tab: 'code'|'costumes'|'sounds' } // initial + on every
//                                                     // change, however it was made. The parent
//                                                     // draws its instructions rail OVER this
//                                                     // editor, so it needs to know when the
//                                                     // student is on the tab that can least
//                                                     // afford the width (Costumes).
// =====================================================================

import debounce from 'lodash.debounce';

import {setTheme} from '../reducers/theme';
import {setFeatureConfig} from '../reducers/feature-config';
import {highlightBlock} from '../reducers/highlight';
import {
    activateTab,
    BLOCKS_TAB_INDEX,
    COSTUMES_TAB_INDEX,
    SOUNDS_TAB_INDEX
} from '../reducers/editor-tab';
import {persistTheme} from '../lib/themes/themePersistance';

// Color Mode toggles between these two enabled themes (dark isn't enabled).
const VALID_THEMES = ['default', 'high-contrast'];

// The editor's tabs, as the wire names them. react-tabs identifies a tab by its
// position in the TabList, which is an implementation detail of this editor's
// markup and not something the parent should ever have to know — so the protocol
// carries a name and the two translations live here, next to each other, where
// they cannot drift apart.
const TAB_NAMES = {
    [BLOCKS_TAB_INDEX]: 'code',
    [COSTUMES_TAB_INDEX]: 'costumes',
    [SOUNDS_TAB_INDEX]: 'sounds'
};
const TAB_INDICES = {
    code: BLOCKS_TAB_INDEX,
    costumes: COSTUMES_TAB_INDEX,
    sounds: SOUNDS_TAB_INDEX
};
// Which feature-config flag gates each tab. Code has none — it is the tab
// everything falls back to, and hiding it was never on offer.
const TAB_FEATURE_FLAGS = {
    costumes: 'costumesTab',
    sounds: 'soundsTab'
};

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
 * Attach the parent-window load/save + autosave bridge to the editor's store.
 * @param {object} store - the Redux store (provided by AppStateHOC onStoreInit).
 * @returns {void}
 */
export default function attachEmbedBridge (store) {
    // Same VM instance the editor renders; it lives in the store from creation.
    const vm = store.getState().scratchGui.vm;

    const post = (msg, transfer) =>
        window.parent.postMessage(msg, PARENT_ORIGIN, transfer);

    // Tell the parent the editor's current Turbo/Color-Mode state so its navbar
    // buttons reflect reality — sent once at attach and after each toggle.
    const reportState = () => {
        const state = store.getState().scratchGui;
        post({type: 'scratch:state', turbo: state.vmStatus.turbo, theme: state.theme.theme});
    };

    // Tell the parent which tab the student is on. Unlike Turbo and Color Mode
    // — which only the parent can now change, so it can report them from its own
    // handlers — the tab is switched from inside the editor: the tab bar, the
    // sprite selector's Costumes shortcut, and adding a costume all reach
    // ACTIVATE_TAB without the parent's involvement. A store subscription is the
    // only thing that sees all of them.
    let lastTabIndex = null;
    const reportTab = () => {
        const index = store.getState().scratchGui.editorTab.activeTabIndex;
        if (index === lastTabIndex) return; // one integer compare per action
        lastTabIndex = index;
        if (TAB_NAMES[index]) post({type: 'scratch:tab-changed', tab: TAB_NAMES[index]});
    };

    // True when the parent may switch to this tab: a name we know, and not one
    // this lesson's feature config has hidden.
    const tabAllowed = name => {
        if (typeof TAB_INDICES[name] !== 'number') return false;
        const flag = TAB_FEATURE_FLAGS[name];
        return !flag || store.getState().scratchGui.featureConfig[flag] !== false;
    };

    // The embedding parent owns the dirty-gated "leave page?" prompt (see
    // ScratchLessonPage). Disable the editor's own guard: project-saver-hoc
    // installs a window.onbeforeunload from the Redux `projectChanged` flag,
    // which our postMessage autosave never resets — so it would warn forever
    // after the first edit, even once everything is saved. onVmInit runs in
    // GUI.componentDidMount, after that HOC's componentWillMount sets it, so
    // this assignment wins and nothing reinstalls it.
    window.onbeforeunload = null;

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

            case 'scratch:set-turbo':
                // Same call the old menu bar made; vm-listener-hoc mirrors the
                // resulting TURBO_MODE_ON/OFF event into Redux.
                vm.setTurboMode(!!data.value);
                reportState();
                break;

            case 'scratch:set-theme':
                // Same effect as the old Color Mode menu: update Redux + cookie.
                if (VALID_THEMES.includes(data.value)) {
                    store.dispatch(setTheme(data.value));
                    persistTheme(data.value);
                    reportState();
                }
                break;

            case 'scratch:set-feature-config':
                // Parent-resolved per-lesson / per-session UI lockdown: dispatch
                // into the featureConfig slice; connected components hide the
                // disabled tabs/buttons.
                store.dispatch(setFeatureConfig(data.config));
                break;

            case 'scratch:highlight-block':
                // A student clicked a block named inline in the lesson
                // instructions. Validate only the shape here — whether the
                // opcode names a block that exists is blocks.jsx's business, and
                // "not there" is a legitimate answer when the lesson has that
                // category disabled.
                if (typeof data.opcode === 'string' && data.opcode) {
                    store.dispatch(highlightBlock(data.opcode));
                }
                break;

            case 'scratch:set-tab':
                // The parent asks for a tab by name. It sends this before a
                // highlight when the palette is not the visible tab, which is
                // the one way `scratch:highlight-block` can appear to do
                // nothing: the highlight lands correctly on a Blocks component
                // that is mounted but off-screen.
                //
                // A tab this lesson has hidden is refused rather than obeyed —
                // feature config exists to keep a student out of the paint
                // editor, and honouring the request would put them there with a
                // tab bar that no longer shows the tab they are on.
                if (tabAllowed(data.tab)) store.dispatch(activateTab(TAB_INDICES[data.tab]));
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

    // Announce readiness so the parent knows it can send the initial project,
    // and report the initial Turbo/Color-Mode state for the parent's buttons.
    post({type: 'scratch:ready'});
    reportState();

    // Report the starting tab before subscribing, so the parent's first
    // tab-changed always describes a settled editor and the subscription only
    // ever carries real changes.
    reportTab();
    store.subscribe(reportTab);
}
