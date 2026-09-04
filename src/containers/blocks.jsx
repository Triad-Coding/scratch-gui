import bindAll from 'lodash.bindall';
import debounce from 'lodash.debounce';
import defaultsDeep from 'lodash.defaultsdeep';
import makeToolboxXML from '../lib/make-toolbox-xml';
import PropTypes from 'prop-types';
import React from 'react';
import VMScratchBlocks from '../lib/blocks';
import VM from 'scratch-vm';

import log from '../lib/log.js';
import Prompt from './prompt.jsx';
import BlocksComponent from '../components/blocks/blocks.jsx';
import ExtensionLibrary from './extension-library.jsx';
import extensionData from '../lib/libraries/extensions/index.jsx';
import CustomProcedures from './custom-procedures.jsx';
import errorBoundaryHOC from '../lib/error-boundary-hoc.jsx';
import {BLOCKS_DEFAULT_SCALE, STAGE_DISPLAY_SIZES} from '../lib/layout-constants';
import DropAreaHOC from '../lib/drop-area-hoc.jsx';
import DragConstants from '../lib/drag-constants';
import defineDynamicBlock from '../lib/define-dynamic-block';
import {DEFAULT_THEME, getColorsForTheme, themeMap} from '../lib/themes';
import {injectExtensionBlockTheme, injectExtensionCategoryTheme} from '../lib/themes/blockHelpers';

import {connect} from 'react-redux';
import {updateToolbox} from '../reducers/toolbox';
import {activateColorPicker} from '../reducers/color-picker';
import {closeExtensionLibrary, openSoundRecorder, openConnectionModal} from '../reducers/modals';
import {activateCustomProcedures, deactivateCustomProcedures} from '../reducers/custom-procedures';
import {setConnectionModalExtensionId} from '../reducers/connection-modal';
import {updateMetrics} from '../reducers/workspace-metrics';
import {isTimeTravel2020} from '../reducers/time-travel';
import {highlightInitialState} from '../reducers/highlight';

import {
    activateTab,
    SOUNDS_TAB_INDEX
} from '../reducers/editor-tab';

const addFunctionListener = (object, property, callback) => {
    const oldFn = object[property];
    object[property] = function (...args) {
        const result = oldFn.apply(this, args);
        callback.apply(this, result);
        return result;
    };
};

// Applied to the highlighted palette block's SVG group. Styled in
// components/blocks/blocks.css, under a :global() because the element belongs to
// scratch-blocks rather than to any React component.
const HIGHLIGHT_CLASS = 'triadHighlightedBlock';

// How far above the block to leave when scrolling it into view, in flyout
// workspace units. Enough that the block does not sit flush against the top
// edge and read as cut off.
const HIGHLIGHT_SCROLL_MARGIN = 24;

const DroppableBlocks = DropAreaHOC([
    DragConstants.BACKPACK_CODE
])(BlocksComponent);

class Blocks extends React.Component {
    constructor (props) {
        super(props);
        this.ScratchBlocks = VMScratchBlocks(props.vm, false);
        bindAll(this, [
            'attachVM',
            'detachVM',
            'getToolboxXML',
            'handleCategorySelected',
            'handleConnectionModalStart',
            'handleDrop',
            'handleStatusButtonUpdate',
            'handleOpenSoundRecorder',
            'handlePromptStart',
            'handlePromptCallback',
            'handlePromptClose',
            'handleCustomProceduresClose',
            'onScriptGlowOn',
            'onScriptGlowOff',
            'onBlockGlowOn',
            'onBlockGlowOff',
            'handleMonitorsUpdate',
            'handleExtensionAdded',
            'handleBlocksInfoUpdate',
            'onTargetsUpdate',
            'onVisualReport',
            'onWorkspaceUpdate',
            'onWorkspaceMetricsChange',
            'setBlocks',
            'setLocale',
            'applyBlockHighlight',
            'paintBlockHighlight',
            'scrollFlyoutToBlock'
        ]);
        this.ScratchBlocks.prompt = this.handlePromptStart;
        this.ScratchBlocks.statusButtonCallback = this.handleConnectionModalStart;
        this.ScratchBlocks.recordSoundCallback = this.handleOpenSoundRecorder;

        this.state = {
            prompt: null
        };
        this.onTargetsUpdate = debounce(this.onTargetsUpdate, 100);
        this.toolboxUpdateQueue = [];
    }
    componentDidMount () {
        this.ScratchBlocks = VMScratchBlocks(this.props.vm, this.props.useCatBlocks);
        this.ScratchBlocks.prompt = this.handlePromptStart;
        this.ScratchBlocks.statusButtonCallback = this.handleConnectionModalStart;
        this.ScratchBlocks.recordSoundCallback = this.handleOpenSoundRecorder;

        this.ScratchBlocks.FieldColourSlider.activateEyedropper_ = this.props.onActivateColorPicker;
        this.ScratchBlocks.Procedures.externalProcedureDefCallback = this.props.onActivateCustomProcedures;
        this.ScratchBlocks.ScratchMsgs.setLocale(this.props.locale);

        const workspaceConfig = defaultsDeep({},
            Blocks.defaultOptions,
            this.props.options,
            {rtl: this.props.isRtl, toolbox: this.props.toolboxXML, colours: getColorsForTheme(this.props.theme)}
        );
        this.workspace = this.ScratchBlocks.inject(this.blocks, workspaceConfig);

        // Register buttons under new callback keys for creating variables,
        // lists, and procedures from extensions.

        const toolboxWorkspace = this.workspace.getFlyout().getWorkspace();

        const varListButtonCallback = type =>
            (() => this.ScratchBlocks.Variables.createVariable(this.workspace, null, type));
        const procButtonCallback = () => {
            this.ScratchBlocks.Procedures.createProcedureDefCallback_(this.workspace);
        };

        toolboxWorkspace.registerButtonCallback('MAKE_A_VARIABLE', varListButtonCallback(''));
        toolboxWorkspace.registerButtonCallback('MAKE_A_LIST', varListButtonCallback('list'));
        toolboxWorkspace.registerButtonCallback('MAKE_A_PROCEDURE', procButtonCallback);

        // Store the xml of the toolbox that is actually rendered.
        // This is used in componentDidUpdate instead of prevProps, because
        // the xml can change while e.g. on the costumes tab.
        this._renderedToolboxXML = this.props.toolboxXML;

        // we actually never want the workspace to enable "refresh toolbox" - this basically re-renders the
        // entire toolbox every time we reset the workspace.  We call updateToolbox as a part of
        // componentDidUpdate so the toolbox will still correctly be updated
        this.setToolboxRefreshEnabled = this.workspace.setToolboxRefreshEnabled.bind(this.workspace);
        this.workspace.setToolboxRefreshEnabled = () => {
            this.setToolboxRefreshEnabled(false);
        };

        // @todo change this when blockly supports UI events
        addFunctionListener(this.workspace, 'translate', this.onWorkspaceMetricsChange);
        addFunctionListener(this.workspace, 'zoom', this.onWorkspaceMetricsChange);

        // FORK: re-paint the parent's palette-block highlight after every flyout
        // re-render. PAINT ONLY — see the ownership note on applyBlockHighlight;
        // scrolling from here is what teleported the palette out from under a
        // student renaming a variable.
        //
        // Five paths re-render the flyout, and they do NOT share a React-visible
        // funnel: updateToolbox() covers three, but Toolbox.refreshSelection()
        // (variable create/rename/delete, and handleCustomProceduresClose below)
        // reaches showAll_ without touching the React lifecycle at all. What all
        // five DO share is Flyout.show(), which rebuilds the block list — so one
        // listener there covers every case, including the ones that bypass us.
        //
        // The sixth path is a theme change, which remounts <Blocks> outright via
        // its key in gui.jsx and takes the DOM highlight with it. That is why the
        // apply below is in componentDidMount and not only in componentDidUpdate:
        // our own scratch:set-theme would otherwise silently wipe the highlight.
        // Mount is also the one re-render where scrolling IS ours to do — there
        // is no prior scroll position to preserve and no other authority awake.
        addFunctionListener(this.workspace.getFlyout(), 'show', this.paintBlockHighlight);

        this.attachVM();
        // Only update blocks/vm locale when visible to avoid sizing issues
        // If locale changes while not visible it will get handled in didUpdate
        if (this.props.isVisible) {
            this.setLocale();
        }

        this.applyBlockHighlight();
    }
    shouldComponentUpdate (nextProps, nextState) {
        return (
            this.state.prompt !== nextState.prompt ||
            this.props.isVisible !== nextProps.isVisible ||
            this._renderedToolboxXML !== nextProps.toolboxXML ||
            this.props.extensionLibraryVisible !== nextProps.extensionLibraryVisible ||
            this.props.customProceduresVisible !== nextProps.customProceduresVisible ||
            this.props.locale !== nextProps.locale ||
            this.props.anyModalVisible !== nextProps.anyModalVisible ||
            this.props.stageSize !== nextProps.stageSize ||
            // FORK: this list is an explicit whitelist, so a new redux prop
            // produces no componentDidUpdate at all unless it is named here.
            // highlightedTime is what makes a REPEAT request for the same opcode
            // a change worth re-rendering for.
            this.props.highlightedOpcode !== nextProps.highlightedOpcode ||
            this.props.highlightedTime !== nextProps.highlightedTime
        );
    }
    componentDidUpdate (prevProps) {
        // If any modals are open, call hideChaff to close z-indexed field editors
        if (this.props.anyModalVisible && !prevProps.anyModalVisible) {
            this.ScratchBlocks.hideChaff();
        }

        // FORK: the parent asked us to point at a (possibly different, possibly
        // repeated) palette block.
        if (this.props.highlightedOpcode !== prevProps.highlightedOpcode ||
            this.props.highlightedTime !== prevProps.highlightedTime) {
            this.applyBlockHighlight();
        }

        // Only rerender the toolbox when the blocks are visible and the xml is
        // different from the previously rendered toolbox xml.
        // Do not check against prevProps.toolboxXML because that may not have been rendered.
        if (this.props.isVisible && this.props.toolboxXML !== this._renderedToolboxXML) {
            this.requestToolboxUpdate();
        }

        if (this.props.isVisible === prevProps.isVisible) {
            if (this.props.stageSize !== prevProps.stageSize) {
                // force workspace to redraw for the new stage size
                window.dispatchEvent(new Event('resize'));
            }
            return;
        }
        // @todo hack to resize blockly manually in case resize happened while hidden
        // @todo hack to reload the workspace due to gui bug #413
        if (this.props.isVisible) { // Scripts tab
            this.workspace.setVisible(true);
            if (prevProps.locale !== this.props.locale || this.props.locale !== this.props.vm.getLocale()) {
                // call setLocale if the locale has changed, or changed while the blocks were hidden.
                // vm.getLocale() will be out of sync if locale was changed while not visible
                this.setLocale();
            } else {
                this.props.vm.refreshWorkspace();
                this.requestToolboxUpdate();
            }

            // FORK: the third and last place the highlight is allowed to move
            // the palette (see the ownership note on applyBlockHighlight).
            //
            // Hiding the Code tab loses the toolbox's own state: coming back
            // repopulates it, which resets the selected category to the first
            // one and the scroll to the top. updateToolbox()'s save/restore
            // cannot recover that — it reads the selection BEFORE its own
            // rebuild, and by then the reset has already happened, so it
            // faithfully restores "Motion, top". Measured: highlight
            // looks_sayforsecs at 967, Code -> Costumes -> Code, and the student
            // is back at Motion with the outlined block ~900px below the fold.
            //
            // A highlight is a standing instruction about where the student
            // should be looking, so re-assert it. Through withToolboxUpdates
            // because the rebuild above is queued on a setTimeout(0) and would
            // otherwise land after us and win.
            this.withToolboxUpdates(() => this.applyBlockHighlight());

            window.dispatchEvent(new Event('resize'));
        } else {
            this.workspace.setVisible(false);
        }
    }
    componentWillUnmount () {
        this.detachVM();
        this.workspace.dispose();
        clearTimeout(this.toolboxUpdateTimeout);

        // Clear the flyout blocks so that they can be recreated on mount.
        this.props.vm.clearFlyoutBlocks();
    }
    requestToolboxUpdate () {
        clearTimeout(this.toolboxUpdateTimeout);
        this.toolboxUpdateTimeout = setTimeout(() => {
            this.updateToolbox();
        }, 0);
    }
    setLocale () {
        this.ScratchBlocks.ScratchMsgs.setLocale(this.props.locale);
        this.props.vm.setLocale(this.props.locale, this.props.messages)
            .then(() => {
                this.workspace.getFlyout().setRecyclingEnabled(false);
                this.props.vm.refreshWorkspace();
                this.requestToolboxUpdate();
                this.withToolboxUpdates(() => {
                    this.workspace.getFlyout().setRecyclingEnabled(true);
                });
            });
    }

    updateToolbox () {
        this.toolboxUpdateTimeout = false;

        const categoryId = this.workspace.toolbox_.getSelectedCategoryId();
        const offset = this.workspace.toolbox_.getCategoryScrollOffset();
        this.workspace.updateToolbox(this.props.toolboxXML);
        this._renderedToolboxXML = this.props.toolboxXML;

        // In order to catch any changes that mutate the toolbox during "normal runtime"
        // (variable changes/etc), re-enable toolbox refresh.
        // Using the setter function will rerender the entire toolbox which we just rendered.
        this.workspace.toolboxRefreshEnabled_ = true;

        const currentCategoryPos = this.workspace.toolbox_.getCategoryPositionById(categoryId);
        const currentCategoryLen = this.workspace.toolbox_.getCategoryLengthById(categoryId);
        if (offset < currentCategoryLen) {
            this.workspace.toolbox_.setFlyoutScrollPos(currentCategoryPos + offset);
        } else {
            this.workspace.toolbox_.setFlyoutScrollPos(currentCategoryPos);
        }

        const queue = this.toolboxUpdateQueue;
        this.toolboxUpdateQueue = [];
        queue.forEach(fn => fn());
    }

    withToolboxUpdates (fn) {
        // if there is a queued toolbox update, we need to wait
        if (this.toolboxUpdateTimeout) {
            this.toolboxUpdateQueue.push(fn);
        } else {
            fn();
        }
    }

    attachVM () {
        this.workspace.addChangeListener(this.props.vm.blockListener);
        this.flyoutWorkspace = this.workspace
            .getFlyout()
            .getWorkspace();
        this.flyoutWorkspace.addChangeListener(this.props.vm.flyoutBlockListener);
        this.flyoutWorkspace.addChangeListener(this.props.vm.monitorBlockListener);
        this.props.vm.addListener('SCRIPT_GLOW_ON', this.onScriptGlowOn);
        this.props.vm.addListener('SCRIPT_GLOW_OFF', this.onScriptGlowOff);
        this.props.vm.addListener('BLOCK_GLOW_ON', this.onBlockGlowOn);
        this.props.vm.addListener('BLOCK_GLOW_OFF', this.onBlockGlowOff);
        this.props.vm.addListener('VISUAL_REPORT', this.onVisualReport);
        this.props.vm.addListener('workspaceUpdate', this.onWorkspaceUpdate);
        this.props.vm.addListener('targetsUpdate', this.onTargetsUpdate);
        this.props.vm.addListener('MONITORS_UPDATE', this.handleMonitorsUpdate);
        this.props.vm.addListener('EXTENSION_ADDED', this.handleExtensionAdded);
        this.props.vm.addListener('BLOCKSINFO_UPDATE', this.handleBlocksInfoUpdate);
        this.props.vm.addListener('PERIPHERAL_CONNECTED', this.handleStatusButtonUpdate);
        this.props.vm.addListener('PERIPHERAL_DISCONNECTED', this.handleStatusButtonUpdate);
    }
    detachVM () {
        this.props.vm.removeListener('SCRIPT_GLOW_ON', this.onScriptGlowOn);
        this.props.vm.removeListener('SCRIPT_GLOW_OFF', this.onScriptGlowOff);
        this.props.vm.removeListener('BLOCK_GLOW_ON', this.onBlockGlowOn);
        this.props.vm.removeListener('BLOCK_GLOW_OFF', this.onBlockGlowOff);
        this.props.vm.removeListener('VISUAL_REPORT', this.onVisualReport);
        this.props.vm.removeListener('workspaceUpdate', this.onWorkspaceUpdate);
        this.props.vm.removeListener('targetsUpdate', this.onTargetsUpdate);
        this.props.vm.removeListener('MONITORS_UPDATE', this.handleMonitorsUpdate);
        this.props.vm.removeListener('EXTENSION_ADDED', this.handleExtensionAdded);
        this.props.vm.removeListener('BLOCKSINFO_UPDATE', this.handleBlocksInfoUpdate);
        this.props.vm.removeListener('PERIPHERAL_CONNECTED', this.handleStatusButtonUpdate);
        this.props.vm.removeListener('PERIPHERAL_DISCONNECTED', this.handleStatusButtonUpdate);
    }

    updateToolboxBlockValue (id, value) {
        this.withToolboxUpdates(() => {
            const block = this.workspace
                .getFlyout()
                .getWorkspace()
                .getBlockById(id);
            if (block) {
                block.inputList[0].fieldRow[0].setValue(value);
            }
        });
    }

    onTargetsUpdate () {
        if (this.props.vm.editingTarget && this.workspace.getFlyout()) {
            ['glide', 'move', 'set'].forEach(prefix => {
                this.updateToolboxBlockValue(`${prefix}x`, Math.round(this.props.vm.editingTarget.x).toString());
                this.updateToolboxBlockValue(`${prefix}y`, Math.round(this.props.vm.editingTarget.y).toString());
            });
        }
    }
    onWorkspaceMetricsChange () {
        const target = this.props.vm.editingTarget;
        if (target && target.id) {
            // Dispatch updateMetrics later, since onWorkspaceMetricsChange may be (very indirectly)
            // called from a reducer, i.e. when you create a custom procedure.
            // TODO: Is this a vehement hack?
            setTimeout(() => {
                this.props.updateMetrics({
                    targetID: target.id,
                    scrollX: this.workspace.scrollX,
                    scrollY: this.workspace.scrollY,
                    scale: this.workspace.scale
                });
            }, 0);
        }
    }
    onScriptGlowOn (data) {
        this.workspace.glowStack(data.id, true);
    }
    onScriptGlowOff (data) {
        this.workspace.glowStack(data.id, false);
    }
    onBlockGlowOn (data) {
        this.workspace.glowBlock(data.id, true);
    }
    onBlockGlowOff (data) {
        this.workspace.glowBlock(data.id, false);
    }
    onVisualReport (data) {
        this.workspace.reportValue(data.id, data.value);
    }
    getToolboxXML () {
        // Use try/catch because this requires digging pretty deep into the VM
        // Code inside intentionally ignores several error situations (no stage, etc.)
        // Because they would get caught by this try/catch
        try {
            let {editingTarget: target, runtime} = this.props.vm;
            const stage = runtime.getTargetForStage();
            if (!target) target = stage; // If no editingTarget, use the stage

            const stageCostumes = stage.getCostumes();
            const targetCostumes = target.getCostumes();
            const targetSounds = target.getSounds();
            const dynamicBlocksXML = injectExtensionCategoryTheme(
                this.props.vm.runtime.getBlocksXML(target),
                this.props.theme
            );
            return makeToolboxXML(false, target.isStage, target.id, dynamicBlocksXML,
                targetCostumes[targetCostumes.length - 1].name,
                stageCostumes[stageCostumes.length - 1].name,
                targetSounds.length > 0 ? targetSounds[targetSounds.length - 1].name : '',
                getColorsForTheme(this.props.theme)
            );
        } catch {
            return null;
        }
    }
    onWorkspaceUpdate (data) {
        // When we change sprites, update the toolbox to have the new sprite's blocks
        const toolboxXML = this.getToolboxXML();
        if (toolboxXML) {
            this.props.updateToolboxState(toolboxXML);
        }

        if (this.props.vm.editingTarget && !this.props.workspaceMetrics.targets[this.props.vm.editingTarget.id]) {
            this.onWorkspaceMetricsChange();
        }

        // Remove and reattach the workspace listener (but allow flyout events)
        this.workspace.removeChangeListener(this.props.vm.blockListener);
        const dom = this.ScratchBlocks.Xml.textToDom(data.xml);
        try {
            this.ScratchBlocks.Xml.clearWorkspaceAndLoadFromXml(dom, this.workspace);
        } catch (error) {
            // The workspace is likely incomplete. What did update should be
            // functional.
            //
            // Instead of throwing the error, by logging it and continuing as
            // normal lets the other workspace update processes complete in the
            // gui and vm, which lets the vm run even if the workspace is
            // incomplete. Throwing the error would keep things like setting the
            // correct editing target from happening which can interfere with
            // some blocks and processes in the vm.
            if (error.message) {
                error.message = `Workspace Update Error: ${error.message}`;
            }
            log.error(error);
        }
        this.workspace.addChangeListener(this.props.vm.blockListener);

        if (this.props.vm.editingTarget && this.props.workspaceMetrics.targets[this.props.vm.editingTarget.id]) {
            const {scrollX, scrollY, scale} = this.props.workspaceMetrics.targets[this.props.vm.editingTarget.id];
            this.workspace.scrollX = scrollX;
            this.workspace.scrollY = scrollY;
            this.workspace.scale = scale;
            this.workspace.resize();
        }

        // Clear the undo state of the workspace since this is a
        // fresh workspace and we don't want any changes made to another sprites
        // workspace to be 'undone' here.
        this.workspace.clearUndo();
    }
    handleMonitorsUpdate (monitors) {
        // Update the checkboxes of the relevant monitors.
        // TODO: What about monitors that have fields? See todo in scratch-vm blocks.js changeBlock:
        // https://github.com/LLK/scratch-vm/blob/2373f9483edaf705f11d62662f7bb2a57fbb5e28/src/engine/blocks.js#L569-L576
        const flyout = this.workspace.getFlyout();
        for (const monitor of monitors.values()) {
            const blockId = monitor.get('id');
            const isVisible = monitor.get('visible');
            flyout.setCheckboxState(blockId, isVisible);
            // We also need to update the isMonitored flag for this block on the VM, since it's used to determine
            // whether the checkbox is activated or not when the checkbox is re-displayed (e.g. local variables/blocks
            // when switching between sprites).
            const block = this.props.vm.runtime.monitorBlocks.getBlock(blockId);
            if (block) {
                block.isMonitored = isVisible;
            }
        }
    }
    handleExtensionAdded (categoryInfo) {
        const defineBlocks = blockInfoArray => {
            if (blockInfoArray && blockInfoArray.length > 0) {
                const staticBlocksJson = [];
                const dynamicBlocksInfo = [];
                blockInfoArray.forEach(blockInfo => {
                    if (blockInfo.info && blockInfo.info.isDynamic) {
                        dynamicBlocksInfo.push(blockInfo);
                    } else if (blockInfo.json) {
                        staticBlocksJson.push(injectExtensionBlockTheme(blockInfo.json, this.props.theme));
                    }
                    // otherwise it's a non-block entry such as '---'
                });

                this.ScratchBlocks.defineBlocksWithJsonArray(staticBlocksJson);
                dynamicBlocksInfo.forEach(blockInfo => {
                    // This is creating the block factory / constructor -- NOT a specific instance of the block.
                    // The factory should only know static info about the block: the category info and the opcode.
                    // Anything else will be picked up from the XML attached to the block instance.
                    const extendedOpcode = `${categoryInfo.id}_${blockInfo.info.opcode}`;
                    const blockDefinition =
                        defineDynamicBlock(this.ScratchBlocks, categoryInfo, blockInfo, extendedOpcode);
                    this.ScratchBlocks.Blocks[extendedOpcode] = blockDefinition;
                });
            }
        };

        // scratch-blocks implements a menu or custom field as a special kind of block ("shadow" block)
        // these actually define blocks and MUST run regardless of the UI state
        defineBlocks(
            Object.getOwnPropertyNames(categoryInfo.customFieldTypes)
                .map(fieldTypeName => categoryInfo.customFieldTypes[fieldTypeName].scratchBlocksDefinition));
        defineBlocks(categoryInfo.menus);
        defineBlocks(categoryInfo.blocks);

        // Update the toolbox with new blocks if possible
        const toolboxXML = this.getToolboxXML();
        if (toolboxXML) {
            this.props.updateToolboxState(toolboxXML);
        }
    }
    handleBlocksInfoUpdate (categoryInfo) {
        // @todo Later we should replace this to avoid all the warnings from redefining blocks.
        this.handleExtensionAdded(categoryInfo);
    }
    handleCategorySelected (categoryId) {
        const extension = extensionData.find(ext => ext.extensionId === categoryId);
        if (extension && extension.launchPeripheralConnectionFlow) {
            this.handleConnectionModalStart(categoryId);
        }

        this.withToolboxUpdates(() => {
            this.workspace.toolbox_.setSelectedCategoryById(categoryId);
        });
    }
    /*
     * FORK: outline one palette block and scroll it into view, on the parent
     * platform's request (embed-bridge.js, `scratch:highlight-block`).
     *
     * PAINTING AND SCROLLING ARE SEPARATE, AND ONLY ONE OF THEM IS OURS TO DO
     * WHENEVER WE LIKE. Painting has to be re-done on every flyout re-render,
     * because flyout blocks are recycled and a recycled block keeps the class it
     * had last time. Scrolling must happen ONLY when the parent asks for a
     * highlight — the flyout re-renders for reasons that have nothing to do with
     * us, and re-scrolling on those is how a student who names a new variable
     * gets teleported from the Variables palette to the top of Motion
     * (`refreshToolboxSelection_` -> `showAll_` -> `Flyout.show()`, measured at
     * 100% on create, rename and delete). The other rebuild paths run through
     * updateToolbox(), which restores the scroll itself on a setTimeout(0); when
     * we also scrolled, which of the two won depended on which path fired.
     *
     * So: `paintBlockHighlight` is hooked to every `Flyout.show()`, and nothing
     * else. `scrollFlyoutToBlock` is called only from `applyBlockHighlight`,
     * which has exactly three callers — mount, a new request from the parent,
     * and the Code tab becoming visible again, where the toolbox has just been
     * repopulated from scratch and there is no earlier position left to keep.
     *
     * The block is found by OPCODE, not by id: make-toolbox-xml.js sets an `id=`
     * attribute on only a handful of palette blocks and the rest get a generated
     * one, so an id is not something a lesson author could ever write down.
     *
     * getTopBlocks(false) on the flyout's workspace is enough to find any block
     * in the palette, with no need to navigate to its category first: Scratch's
     * toolbox is ONE continuous flyout holding every category's blocks at once
     * (Toolbox.showAll_), and the category menu is a set of scroll anchors into
     * it. Scrolling to the block therefore also updates the selected category by
     * itself — Flyout.selectCategoryByScrollPosition does that off the scroll
     * event, so there is no opcode-to-category table to keep in step.
     *
     * Deliberately NOT glowBlock: that throws on an unknown id, and it is the
     * same yellow running-glow the VM drives through onBlockGlowOn, so a
     * highlight would be indistinguishable from "this block is running" and
     * would fight a running project for the same element.
     */
    applyBlockHighlight () {
        const target = this.paintBlockHighlight();
        if (target) this.scrollFlyoutToBlock(target);
    }
    /**
     * Put the outline on the requested block, taking it off any other. Safe to
     * call on every flyout re-render, and does not move the palette.
     * @returns {?Blockly.BlockSvg} the outlined block, or null if there is no
     *     highlight to show or the block is not in this palette.
     */
    paintBlockHighlight () {
        if (!this.workspace) return null;
        const flyout = this.workspace.getFlyout();
        const flyoutWorkspace = flyout && flyout.getWorkspace();
        if (!flyoutWorkspace) return null;

        const blocks = flyoutWorkspace.getTopBlocks(false);

        // Clear first, unconditionally. Flyout blocks are RECYCLED — show()
        // reuses the BlockSVG keyed by id-or-type (flyout_base.js
        // clearOldBlocks_/show) — and a recycled block keeps the class attribute
        // it had last time, so a stale outline would survive a re-render and
        // accumulate a second one.
        let cleared = false;
        for (const block of blocks) {
            const root = block.getSvgRoot();
            if (root && root.classList.contains(HIGHLIGHT_CLASS)) {
                root.classList.remove(HIGHLIGHT_CLASS);
                cleared = true;
            }
        }

        const opcode = this.props.highlightedOpcode;
        if (!opcode) return null;

        const target = blocks.find(block => block.type === opcode);
        if (!target) {
            // A legitimate answer, not an error: a disabled category means the
            // block genuinely is not in this student's palette (feature config
            // can remove the extension blocks). Say nothing and do nothing.
            return null;
        }

        const root = target.getSvgRoot();
        if (!root) return null;

        // Force a reflow between the remove and the add so that re-sending the
        // SAME opcode restarts the attention animation. Without it the browser
        // coalesces both class changes into one style recalculation and the
        // animation never re-triggers — which is precisely the case a student
        // clicking the same phrase twice hits.
        if (cleared) root.getBoundingClientRect();
        root.classList.add(HIGHLIGHT_CLASS);

        return target;
    }
    /**
     * Bring the outlined block into view. Only ever called for a request the
     * parent actually made — see the ownership note above.
     * @param {!Blockly.BlockSvg} target the block to scroll to
     */
    scrollFlyoutToBlock (target) {
        // Everything else in this pair null-checks; toolbox_ was the one
        // dereference that did not, and it runs inside a redux-driven
        // componentDidUpdate behind errorBoundaryHOC('Blocks') — so a throw here
        // takes the whole editor down and shows the crash screen.
        const toolbox = this.workspace && this.workspace.toolbox_;
        if (!toolbox) return;

        // Cancel any category animation still in flight. `setFlyoutScrollPos`
        // ends at `scrollbar_.set()`, which moves the flyout without touching
        // `scrollTarget` — so a rAF from `stepScrollAnimation` fires on the next
        // frame and converges back on the category the student was leaving. The
        // palette flicks to the block for one frame and scrolls all the way
        // back. `Flyout.wheel_` nulls this for exactly the same reason, which is
        // the precedent for reaching into the field here.
        //
        // It also unblocks the category menu: `selectCategoryByScrollPosition`
        // returns early while `scrollTarget` is set, so without this the menu
        // keeps naming the old category after we have jumped somewhere else.
        const flyout = this.workspace.getFlyout();
        if (flyout) flyout.scrollTarget = null;

        // Scroll the block itself into view rather than its category, which is
        // both more precise and how the category menu ends up correct for free.
        const y = target.getRelativeToSurfaceXY().y;
        toolbox.setFlyoutScrollPos(Math.max(0, y - HIGHLIGHT_SCROLL_MARGIN));
    }
    setBlocks (blocks) {
        this.blocks = blocks;
    }
    handlePromptStart (message, defaultValue, callback, optTitle, optVarType) {
        const p = {prompt: {callback, message, defaultValue}};
        p.prompt.title = optTitle ? optTitle :
            this.ScratchBlocks.Msg.VARIABLE_MODAL_TITLE;
        p.prompt.varType = typeof optVarType === 'string' ?
            optVarType : this.ScratchBlocks.SCALAR_VARIABLE_TYPE;
        p.prompt.showVariableOptions = // This flag means that we should show variable/list options about scope
            optVarType !== this.ScratchBlocks.BROADCAST_MESSAGE_VARIABLE_TYPE &&
            p.prompt.title !== this.ScratchBlocks.Msg.RENAME_VARIABLE_MODAL_TITLE &&
            p.prompt.title !== this.ScratchBlocks.Msg.RENAME_LIST_MODAL_TITLE;
        p.prompt.showCloudOption = (optVarType === this.ScratchBlocks.SCALAR_VARIABLE_TYPE) && this.props.canUseCloud;
        this.setState(p);
    }
    handleConnectionModalStart (extensionId) {
        this.props.onOpenConnectionModal(extensionId);
    }
    handleStatusButtonUpdate () {
        this.ScratchBlocks.refreshStatusButtons(this.workspace);
    }
    handleOpenSoundRecorder () {
        this.props.onOpenSoundRecorder();
    }

    /*
     * Pass along information about proposed name and variable options (scope and isCloud)
     * and additional potentially conflicting variable names from the VM
     * to the variable validation prompt callback used in scratch-blocks.
     */
    handlePromptCallback (input, variableOptions) {
        this.state.prompt.callback(
            input,
            this.props.vm.runtime.getAllVarNamesOfType(this.state.prompt.varType),
            variableOptions);
        this.handlePromptClose();
    }
    handlePromptClose () {
        this.setState({prompt: null});
    }
    handleCustomProceduresClose (data) {
        this.props.onRequestCloseCustomProcedures(data);
        const ws = this.workspace;
        ws.refreshToolboxSelection_();
        ws.toolbox_.scrollToCategoryById('myBlocks');
    }
    handleDrop (dragInfo) {
        fetch(dragInfo.payload.bodyUrl)
            .then(response => response.json())
            .then(blocks => this.props.vm.shareBlocksToTarget(blocks, this.props.vm.editingTarget.id))
            .then(() => {
                this.props.vm.refreshWorkspace();
                this.updateToolbox(); // To show new variables/custom blocks
            });
    }
    render () {
        /* eslint-disable no-unused-vars */
        const {
            anyModalVisible,
            canUseCloud,
            customProceduresVisible,
            extensionLibraryVisible,
            highlightedOpcode,
            highlightedTime,
            options,
            stageSize,
            vm,
            isRtl,
            isVisible,
            onActivateColorPicker,
            onOpenConnectionModal,
            onOpenSoundRecorder,
            updateToolboxState,
            onActivateCustomProcedures,
            onRequestCloseExtensionLibrary,
            onRequestCloseCustomProcedures,
            toolboxXML,
            updateMetrics: updateMetricsProp,
            useCatBlocks,
            workspaceMetrics,
            ...props
        } = this.props;
        /* eslint-enable no-unused-vars */
        return (
            <React.Fragment>
                <DroppableBlocks
                    componentRef={this.setBlocks}
                    onDrop={this.handleDrop}
                    {...props}
                />
                {this.state.prompt ? (
                    <Prompt
                        defaultValue={this.state.prompt.defaultValue}
                        isStage={vm.runtime.getEditingTarget().isStage}
                        showListMessage={this.state.prompt.varType === this.ScratchBlocks.LIST_VARIABLE_TYPE}
                        label={this.state.prompt.message}
                        showCloudOption={this.state.prompt.showCloudOption}
                        showVariableOptions={this.state.prompt.showVariableOptions}
                        title={this.state.prompt.title}
                        vm={vm}
                        onCancel={this.handlePromptClose}
                        onOk={this.handlePromptCallback}
                    />
                ) : null}
                {extensionLibraryVisible ? (
                    <ExtensionLibrary
                        vm={vm}
                        onCategorySelected={this.handleCategorySelected}
                        onRequestClose={onRequestCloseExtensionLibrary}
                    />
                ) : null}
                {customProceduresVisible ? (
                    <CustomProcedures
                        options={{
                            media: options.media
                        }}
                        onRequestClose={this.handleCustomProceduresClose}
                    />
                ) : null}
            </React.Fragment>
        );
    }
}

Blocks.propTypes = {
    anyModalVisible: PropTypes.bool,
    canUseCloud: PropTypes.bool,
    customProceduresVisible: PropTypes.bool,
    extensionLibraryVisible: PropTypes.bool,
    highlightedOpcode: PropTypes.string,
    highlightedTime: PropTypes.number,
    isRtl: PropTypes.bool,
    isVisible: PropTypes.bool,
    locale: PropTypes.string.isRequired,
    messages: PropTypes.objectOf(PropTypes.string),
    onActivateColorPicker: PropTypes.func,
    onActivateCustomProcedures: PropTypes.func,
    onOpenConnectionModal: PropTypes.func,
    onOpenSoundRecorder: PropTypes.func,
    onRequestCloseCustomProcedures: PropTypes.func,
    onRequestCloseExtensionLibrary: PropTypes.func,
    options: PropTypes.shape({
        media: PropTypes.string,
        zoom: PropTypes.shape({
            controls: PropTypes.bool,
            wheel: PropTypes.bool,
            startScale: PropTypes.number
        }),
        comments: PropTypes.bool,
        collapse: PropTypes.bool
    }),
    stageSize: PropTypes.oneOf(Object.keys(STAGE_DISPLAY_SIZES)).isRequired,
    theme: PropTypes.oneOf(Object.keys(themeMap)),
    toolboxXML: PropTypes.string,
    updateMetrics: PropTypes.func,
    updateToolboxState: PropTypes.func,
    useCatBlocks: PropTypes.bool,
    vm: PropTypes.instanceOf(VM).isRequired,
    workspaceMetrics: PropTypes.shape({
        targets: PropTypes.objectOf(PropTypes.object)
    })
};

Blocks.defaultOptions = {
    zoom: {
        controls: true,
        wheel: true,
        startScale: BLOCKS_DEFAULT_SCALE
    },
    grid: {
        spacing: 40,
        length: 2,
        colour: '#ddd'
    },
    comments: true,
    collapse: false,
    sounds: false
};

Blocks.defaultProps = {
    isVisible: true,
    options: Blocks.defaultOptions,
    theme: DEFAULT_THEME
};

const mapStateToProps = state => ({
    anyModalVisible: (
        Object.keys(state.scratchGui.modals).some(key => state.scratchGui.modals[key]) ||
        state.scratchGui.mode.isFullScreen
    ),
    extensionLibraryVisible: state.scratchGui.modals.extensionLibrary,
    // FORK: the palette block the parent platform's lesson instructions are
    // pointing at. Falls back to the slice's initial state so a host store
    // assembled without this reducer still renders.
    highlightedOpcode: (state.scratchGui.highlight || highlightInitialState).highlightedOpcode,
    highlightedTime: (state.scratchGui.highlight || highlightInitialState).highlightedTime,
    isRtl: state.locales.isRtl,
    locale: state.locales.locale,
    messages: state.locales.messages,
    toolboxXML: state.scratchGui.toolbox.toolboxXML,
    customProceduresVisible: state.scratchGui.customProcedures.active,
    workspaceMetrics: state.scratchGui.workspaceMetrics,
    useCatBlocks: isTimeTravel2020(state)
});

const mapDispatchToProps = dispatch => ({
    onActivateColorPicker: callback => dispatch(activateColorPicker(callback)),
    onActivateCustomProcedures: (data, callback) => dispatch(activateCustomProcedures(data, callback)),
    onOpenConnectionModal: id => {
        dispatch(setConnectionModalExtensionId(id));
        dispatch(openConnectionModal());
    },
    onOpenSoundRecorder: () => {
        dispatch(activateTab(SOUNDS_TAB_INDEX));
        dispatch(openSoundRecorder());
    },
    onRequestCloseExtensionLibrary: () => {
        dispatch(closeExtensionLibrary());
    },
    onRequestCloseCustomProcedures: data => {
        dispatch(deactivateCustomProcedures(data));
    },
    updateToolboxState: toolboxXML => {
        dispatch(updateToolbox(toolboxXML));
    },
    updateMetrics: metrics => {
        dispatch(updateMetrics(metrics));
    }
});

export default errorBoundaryHOC('Blocks')(
    connect(
        mapStateToProps,
        mapDispatchToProps
    )(Blocks)
);
