// Feature config for the embedded editor. The parent platform resolves which
// editor elements to show for a given lesson / live session and pushes the
// result in over postMessage (see playground/embed-bridge.js, message type
// `scratch:set-feature-config`). This is the editor's own consumer-side view of
// that config — a flat set of "shown" booleans read by the components that
// render each element. Everything defaults to shown, so an editor that never
// receives the message behaves exactly as it always has.

const SET_FEATURE_CONFIG = 'scratch-gui/feature-config/SET_FEATURE_CONFIG';

const featureConfigInitialState = {
    costumesTab: true,
    soundsTab: true,
    addExtension: true,
    addSprite: true,
    addBackdrop: true
};

const reducer = function (state, action) {
    if (typeof state === 'undefined') state = featureConfigInitialState;
    switch (action.type) {
    case SET_FEATURE_CONFIG:
        // Merge so a partial payload only overrides the keys it names; unknown
        // keys are ignored and absent keys keep their current (default) value.
        return Object.assign({}, state, action.config);
    default:
        return state;
    }
};

const setFeatureConfig = function (config) {
    return {
        type: SET_FEATURE_CONFIG,
        config: config || {}
    };
};

export {
    reducer as default,
    featureConfigInitialState,
    setFeatureConfig
};
