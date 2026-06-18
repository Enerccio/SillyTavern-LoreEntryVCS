import {getSettings, log, setSettings} from "./utils.js";
import {debounce} from '/scripts/utils.js';
import {loadWorldInfo, world_names} from "/scripts/world-info.js";

const REVISION_UI_HTML = `
<div class="revision-control-panel" style="width: 100%; box-sizing: border-box; padding: 10px; border-bottom: 1px solid #444; margin-bottom: 10px; background: rgba(0,0,0,0.2); border-radius: 4px;">
    <div class="flex-container justifySpaceBetween alignitemscenter">
        <div class="revision-info">
            <span style="font-weight: bold;">Revision: </span>
            <span class="rev-index-display" style="opacity: 0.9;">None</span>
            <small class="rev-meta-display" style="display:block; opacity: 0.6; font-size: 0.85em; margin-top: 2px;">
                Modified: <span class="rev-modified-text">-</span>
            </small>
        </div>
        <div class="flex-container flexGap5 alignitemscenter">
            <button type="button" class="menu_button rev-btn-delete" title="Delete current revision" style="background: #5a2a2a;">-</button>
            <button type="button" class="menu_button rev-btn-prev" title="Previous revision">◀</button>
            <select class="text_pole rev-select" style="width: 130px; margin: 0 4px;"></select>
            <button type="button" class="menu_button rev-btn-next" title="Next revision">▶</button>
            <button type="button" class="menu_button rev-btn-add" title="Create snapshot revision" style="background: #2a5a3a;">+</button>
        </div>
    </div>
</div>`;

class LoreEntryRevision {
    constructor() {
        this.revisionId = null;
        this.lastModified = null;
        this.data = {};

        this.fields = [
            'key', 'entryLogicType', 'keysecondary', 'outletName', 'scanDepth',
            'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId',
            'delayUntilRecursionLevel', 'content', 'group', 'groupWeight', 'sticky',
            'cooldown', 'delay', 'characterFilter', 'triggers', 'comment',
            'position', 'depth', 'order', 'probability'
        ];

        this.checkboxes = [
            'excludeRecursion', 'preventRecursion', 'delay_until_recursion',
            'ignoreBudget', 'groupOverride', 'character_exclusion', 'selective',
            'useProbability', 'addMemo', 'matchCharacterDescription',
            'matchCharacterPersonality', 'matchScenario', 'matchPersonaDescription',
            'matchCharacterDepthPrompt', 'matchCreatorNotes'
        ];
    }

    /**
     * Overwrites native DOM elements with this revision's data payload
     */
    applyToDom(container) {
        const $container = $(container);
        this.fields.forEach(name => {
            const val = this.data[name] !== undefined ? this.data[name] : '';
            $container.find(`[name="${name}"]`)
                .val(val)
                .trigger('chosen:updated')
                .trigger('input')   // Notifies ST input observers
                .trigger('change'); // Notifies ST change observers
        });
        this.checkboxes.forEach(name => {
            const checked = !!this.data[name];
            $container.find(`[name="${name}"]`)
                .prop('checked', checked)
                .trigger('change'); // Notifies ST checkbox observers
        });
    }

    /**
     * Listens to DOM updates natively on this container using a .vcs namespace
     */
    bindToDom(container) {
        const $container = $(container);

        this.fields.forEach(name => {
            $container.find(`[name="${name}"]`).on('input.vcs change.vcs', (e) => {
                this.updateData(name, $(e.target).val());
            });
        });

        this.checkboxes.forEach(name => {
            $container.find(`[name="${name}"]`).on('change.vcs', (e) => {
                this.updateData(name, $(e.target).is(':checked'));
            });
        });
    }

    updateData(key, value) {
        this.data[key] = value;
        this.lastModified = Date.now();
        this.save();
    }

    save() {
        // Bubble saving behavior upward to your manager instance
        if (typeof vcs !== 'undefined' && vcs.save) {
            vcs.save();
        }
    }

    static fromJson(revision) {
        const instance = new LoreEntryRevision();
        instance.revisionId = revision.revisionId;
        instance.lastModified = revision.lastModified;
        instance.data = revision.data || {};
        return instance;
    }

    toJson() {
        return {
            revisionId: this.revisionId,
            lastModified: this.lastModified,
            data: this.data
        };
    }
}

class LoreEntry {
    constructor() {
        this.id = null;
        this.revisions = [];
        this.currentRevision = -1;
    }

    /**
     * Binds tracking to the toolbar UI components and triggers initialization
     */
    bindToDom(container) {
        const $container = $(container);

        // Core Actions
        $container.find('.rev-btn-add').off('.vcs_meta').on('click.vcs_meta', () => {
            this.createNewRevisionFromCurrentState($container);
        });

        $container.find('.rev-btn-delete').off('.vcs_meta').on('click.vcs_meta', () => {
            this.deleteCurrentRevision($container);
        });

        $container.find('.rev-btn-prev').off('.vcs_meta').on('click.vcs_meta', () => {
            this.switchToRevision(this.currentRevision - 1, $container);
        });

        $container.find('.rev-btn-next').off('.vcs_meta').on('click.vcs_meta', () => {
            this.switchToRevision(this.currentRevision + 1, $container);
        });

        $container.find('.rev-select').off('.vcs_meta').on('change.vcs_meta', (e) => {
            const idx = parseInt($(e.target).val(), 10);
            this.switchToRevision(idx, $container);
        });

        // If there are no existing versions, automatically instantiate an initial track snapshot
        if (this.revisions.length === 0) {
            this.createNewRevisionFromCurrentState($container);
        } else {
            this.switchToRevision(this.currentRevision !== -1 ? this.currentRevision : 0, $container);
        }
    }

    /**
     * Handles rewriting the fields, cleaning listeners, and establishing new tracking bindings
     */
    switchToRevision(index, $container) {
        if (index < 0 || index >= this.revisions.length) return;

        this.currentRevision = index;
        const revision = this.revisions[index];

        // 1. Scrub old input-tracking listeners to prevent historical modifications bleeding across versions
        $container.find('input, textarea, select').off('.vcs');

        // 2. Overwrite input elements in the DOM natively
        revision.applyToDom($container);

        // 3. Re-bind input triggers to match the now-active version object
        revision.bindToDom($container);

        // 4. Update control displays
        this.updateUiDisplay($container);

        // Save state index changes
        if (typeof vcs !== 'undefined') vcs.save();
    }

    createNewRevisionFromCurrentState($container) {
        const newRev = new LoreEntryRevision();
        newRev.revisionId = `rev-${Date.now()}`;
        newRev.lastModified = Date.now();

        // Fill initial payload fields directly out of the current physical state of the DOM
        newRev.fields.forEach(name => {
            newRev.data[name] = $container.find(`[name="${name}"]`).val();
        });
        newRev.checkboxes.forEach(name => {
            newRev.data[name] = $container.find(`[name="${name}"]`).is(':checked');
        });

        this.revisions.push(newRev);
        this.switchToRevision(this.revisions.length - 1, $container);
    }

    deleteCurrentRevision($container) {
        if (this.revisions.length <= 1) {
            alert("Cannot delete the final remaining revision trail.");
            return;
        }
        this.revisions.splice(this.currentRevision, 1);
        const nextTarget = Math.max(0, this.currentRevision - 1);
        this.switchToRevision(nextTarget, $container);
    }

    updateUiDisplay($container) {
        const total = this.revisions.length;
        const humanIndex = this.currentRevision + 1;

        $container.find('.rev-index-display').text(`${humanIndex} / ${total}`);

        const current = this.revisions[this.currentRevision];
        const dateStr = current ? new Date(current.lastModified).toLocaleTimeString() : '-';
        $container.find('.rev-modified-text').text(dateStr);

        // Render drop-down choices dynamically
        const $select = $container.find('.rev-select');
        $select.empty();
        this.revisions.forEach((rev, idx) => {
            const optTitle = `Rev ${idx + 1} (${new Date(rev.lastModified).toLocaleTimeString()})`;
            const selectedAttr = idx === this.currentRevision ? 'selected' : '';
            $select.append(`<option value="${idx}" ${selectedAttr}>${optTitle}</option>`);
        });
    }

    static fromJson(entry) {
        const loreEntry = new LoreEntry();
        loreEntry.id = entry.id;
        loreEntry.revisions = (entry.revisions || []).map(revision => LoreEntryRevision.fromJson(revision));
        loreEntry.currentRevision = entry.currentRevision !== undefined ? entry.currentRevision : -1;
        return loreEntry;
    }

    toJson() {
        return {
            id: this.id,
            revisions: this.revisions.map(revision => revision.toJson()),
            currentRevision: this.currentRevision
        };
    }
}

class WorldInfo {

    constructor() {
        this.id = null;
        this.entries = [];
    }

    static fromJson(json) {
        const worldInfo = new WorldInfo();
        worldInfo.id = json.id;
        if (json.entries) {
            worldInfo.entries = json.entries.map(entry => LoreEntry.fromJson(entry));
        }
        return worldInfo;
    }

    toJson() {
        return {
            id: this.id,
            entries: this.entries.map(entry => entry.toJson())
        };
    }

    async firstLoad(worldInfoId) {
        this.id = worldInfoId;
        this.bind();
    }

    bind() {
        const $container = $('#world_popup_entries_list');
    }

    bindElement(uid, $container) {
        const entry = this.entries.find(e => e.id === uid);
        if (entry) {
            entry.bindToDom($container);
        } else {
            const newEntry = new LoreEntry();
            newEntry.id = uid;
            this.entries.push(newEntry);
            newEntry.bindToDom($container);
        }
    }

}

class WorldInfoVCSManager {

    constructor() {
        this.current = null;
        this.lorebooks = getSettings("lorebooks", true, []);

        this.save = debounce(() => {
            this.persistToStorage();
        });
    }

    persistToStorage() {
        if (this.current) {
            log("Saving lorebook: " + this.current.id);
            setSettings(`lorebook_${this.current.id}`, this.current.toJson());
        }
    }

    async load(worldInfoId) {
        if (worldInfoId === null) {
            this.current = null;
        } else {
            if (this.lorebooks.includes(worldInfoId)) {
                this.current = WorldInfo.fromJson(getSettings(`lorebook_${worldInfoId}`));
                this.current.bind();
            } else {
                this.current = new WorldInfo();
                await this.current.firstLoad(worldInfoId);
                this.lorebooks.push(worldInfoId);
                setSettings("lorebooks", this.lorebooks);
                this.save();
            }
        }
    }

    async openEditor($container) {
        const owner = $container.closest('.world_entry');
        const uid = owner.data('uid');
        this.current.bindElement(uid, $container);
    }

}

const vcs = new WorldInfoVCSManager();

$(function () {
    // Inject our interface directly into the master entry edit template
    const $template = $('#entry_edit_template .world_entry_edit');
    if ($template.length > 0) {
        $template.prepend(REVISION_UI_HTML);
    }

    $('#world_editor_select').on('change', async () => {
        const selectedIndex = String($('#world_editor_select').find(':selected').val());

        if (selectedIndex === '') {
            await vcs.load(null);
        } else {
            const worldName = world_names[selectedIndex];
            setTimeout(async () => {
                const wi = await loadWorldInfo(worldName);
                if (wi) {
                    await vcs.load(worldName);
                }
            })
        }
    });

    $(document).on('click', '.world_entry', function() {
        const $container = $(this).find('.world_entry_edit');
        if ($container.length && !$container.data('vcs-bound')) {
            vcs.openEditor($container);
            $container.data('vcs-bound', true);
        }
    });

    // this is so dumb but we have to do it
    $('#world_popup_name_button').off('click').on('click', async (e) => {

    });
});
