// Palette-block highlight for the embedded editor (Triad-Coding fork).
//
// The parent platform's lesson instructions can name a block inline — "find the
// block that says move 10 steps" — and clicking that phrase asks the editor to
// point at it. The parent sends `scratch:highlight-block` (see
// playground/embed-bridge.js) and it lands here; containers/blocks.jsx does the
// scrolling and the outline.
//
// WE STORE THE OPCODE, NEVER A BLOCK ID. make-toolbox-xml.js gives only a
// handful of palette blocks an `id=` attribute, so most of them get a generated
// one that changes per session and that no lesson author could ever write down.
// blocks.jsx therefore looks the block up by `block.type === opcode`.
//
// The TIME field exists for the same reason targets.js has highlightedTargetTime
// beside highlightedTargetId: re-sending the SAME opcode has to re-trigger the
// highlight, and a value equal to its predecessor cannot do that on its own. A
// student who clicks the same phrase twice is the ordinary case, not an edge one.

const HIGHLIGHT_BLOCK = 'scratch-gui/highlight/HIGHLIGHT_BLOCK';
const CLEAR_HIGHLIGHT = 'scratch-gui/highlight/CLEAR_HIGHLIGHT';

const highlightInitialState = {
    highlightedOpcode: null,
    highlightedTime: null
};

const reducer = function (state, action) {
    if (typeof state === 'undefined') state = highlightInitialState;
    switch (action.type) {
    case HIGHLIGHT_BLOCK:
        return Object.assign({}, state, {
            highlightedOpcode: action.opcode,
            highlightedTime: action.updateTime
        });
    case CLEAR_HIGHLIGHT:
        return Object.assign({}, state, highlightInitialState);
    default:
        return state;
    }
};

/**
 * Ask for one palette block to be outlined.
 * @param {string} opcode the block's opcode, e.g. 'motion_movesteps'
 * @param {number} updateTime monotonically increasing; makes a repeat request distinct
 * @returns {object} the action
 */
const highlightBlock = function (opcode, updateTime) {
    return {
        type: HIGHLIGHT_BLOCK,
        opcode: opcode,
        updateTime: typeof updateTime === 'number' ? updateTime : Date.now()
    };
};

const clearHighlight = function () {
    return {type: CLEAR_HIGHLIGHT};
};

export {
    reducer as default,
    highlightInitialState,
    highlightBlock,
    clearHighlight
};
