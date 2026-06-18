import {delSetting, getSettings, log, setSettings} from "./utils.js";
import {debounce} from '/scripts/utils.js';
import {loadWorldInfo, world_names} from "/scripts/world-info.js";
import {Popup} from "/scripts/popup.js";

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

    /**
     * Compares the current physical DOM values against this revision's cached payload.
     * Returns true if they match perfectly, false if the DOM has diverged.
     */
    matchesDom(container) {
        const $container = $(container);

        // Check standard text/select fields
        for (const name of this.fields) {
            const domVal = $container.find(`[name="${name}"]`).val() ?? '';
            const storedVal = this.data[name] ?? '';
            // Cast to string to prevent loose type-coercion bugs (e.g., numbers vs strings)
            if (String(domVal) !== String(storedVal)) return false;
        }

        // Check checkboxes
        for (const name of this.checkboxes) {
            const domChecked = $container.find(`[name="${name}"]`).is(':checked');
            const storedChecked = !!this.data[name];
            if (domChecked !== storedChecked) return false;
        }

        return true;
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
        this.uid = null;
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

        if (this.revisions.length === 0) {
            // No history exists yet? Take a snapshot of the current DOM state
            this.createNewRevisionFromCurrentState($container);
        } else {
            const targetIndex = this.currentRevision !== -1 ? this.currentRevision : 0;
            const targetRevision = this.revisions[targetIndex];

            // Evaluate if the DOM text has outpaced our history tracker
            if (targetRevision && !targetRevision.matchesDom($container)) {
                log(`VCS: Desynchronization detected for entry UID ${this.uid} (offline edits found). Creating auto-snapshot.`);

                // Instantly capture the offline changes as the newest version history node
                this.createNewRevisionFromCurrentState($container);
            } else {
                // The DOM matches our records perfectly. Safe to restore state and bind event tracking.
                this.switchToRevision(targetIndex, $container);
            }
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
        loreEntry.uid = entry.uid;
        loreEntry.revisions = (entry.revisions || []).map(revision => LoreEntryRevision.fromJson(revision));
        loreEntry.currentRevision = entry.currentRevision !== undefined ? entry.currentRevision : -1;
        return loreEntry;
    }

    toJson() {
        return {
            uid: this.uid,
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
        const entry = this.entries.find(e => e.uid === uid);
        if (entry) {
            entry.bindToDom($container);
        } else {
            const newEntry = new LoreEntry();
            newEntry.uid = uid;
            this.entries.push(newEntry);
            newEntry.bindToDom($container);
        }
    }

}

class WorldInfoVCSManager {

    constructor() {
        this.current = null;
        this.lorebooks = getSettings("lorebooks", true, []);
        this.pendingRename = null;

        this.save = debounce(() => {
            this.persistToStorage();
        });
    }

    confirmDelete(uid) {
        if (uid !== undefined && uid !== null && this.current) {
            log(`VCS: Purging tracking metadata for entry UID ${uid}`);
            // Loose inequality check balances string/number coercion from data attributes safely
            // noinspection EqualityComparisonWithCoercionJS
            this.current.entries = this.current.entries.filter(e => e.uid != uid);
            this.save();
        }
    }

    confirmDeleteWorld(worldInfoId) {
        if (worldInfoId && this.lorebooks.includes(worldInfoId)) {
            log(`VCS: Purging all tracking metadata for world ID ${worldInfoId}`);
            delSetting(`lorebook_${worldInfoId}`);
            this.lorebooks = this.lorebooks.filter(id => id !== worldInfoId);
            setSettings("lorebooks", this.lorebooks);

            if (this.current && this.current.id === worldInfoId) {
                this.current = null;
            }
            this.save();
        }
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
            // Handle pending rename data migration
            if (this.pendingRename && this.pendingRename.newName === worldInfoId) {
                const {oldName, newName} = this.pendingRename;
                this.pendingRename = null; // Clear it immediately because the expected event fired!

                const isOldDeleted = typeof world_names !== 'undefined' ? !world_names.includes(oldName) : true;
                if (this.lorebooks.includes(oldName) && isOldDeleted) {
                    log(`VCS: Rename confirmed from ${oldName} to ${newName}. Migrating tracking history.`);
                    const oldData = getSettings(`lorebook_${oldName}`);
                    if (oldData) {
                        oldData.id = newName;
                        setSettings(`lorebook_${newName}`, oldData);
                        delSetting(`lorebook_${oldName}`);

                        this.lorebooks = this.lorebooks.filter(id => id !== oldName);
                        this.lorebooks.push(newName);
                        setSettings("lorebooks", this.lorebooks);
                    }
                }
            } else {
                this.pendingRename = null;
            }

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

    totalPurge() {
        for (const worldInfoId of this.lorebooks) {
            delSetting(`lorebook_${worldInfoId}`);
        }
        this.lorebooks = [];
        this.save();
    }

    wireBindGlobalPanel() {
        const PANEL_HTML = `
        <div id="vcs_global_panel" class="flex-container alignitemscenter" style="width: 100%; box-sizing: border-box; padding: 5px 10px; background: rgba(0,0,0,0.15); margin: 5px 0; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
            <span style="font-weight: bold; flex: 1; opacity: 0.85;" data-i18n="VCS Revisions">Revisions</span>
            <div class="flex-container flexGap5">
                <input type="file" id="vcs_global_import_file" accept=".json" style="display: none;">
                <div id="vcs_global_import_btn" class="menu_button fa-solid fa-file-import interactable" title="Import VCS History JSON" role="button"></div>
                <div id="vcs_global_export_btn" class="menu_button fa-solid fa-file-export interactable" title="Export VCS History JSON" role="button"></div>
            </div>
        </div>`;

        // Safely insert between targeted layout rows
        const $target = $('#world_popup > div:nth-child(2)');
        if ($target.length > 0) {
            $target.after(PANEL_HTML);
        }

        // Logic handler to compile and export the tracking configuration
        $(document).off('click', '#vcs_global_export_btn').on('click', '#vcs_global_export_btn', () => {
            if (!this.current || !this.current.id) {
                toastr.warning("No active lorebook selected to export history records.");
                return;
            }

            const dataStr = JSON.stringify(this.current.toJson(), null, 4);
            const blob = new Blob([dataStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);

            const downloadLink = document.createElement("a");
            downloadLink.href = url;
            downloadLink.download = `${this.current.id}_vcs_history.json`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);

            log(`VCS: Exported system tracking snapshot for ${this.current.id}`);
        });

        // Trigger native file selection wrapper mechanics via matching input proxy click events
        $(document).off('click', '#vcs_global_import_btn').on('click', '#vcs_global_import_btn', () => {
            if (!this.current || !this.current.id) {
                toastr.warning("Please select or create an active lorebook profile before importing tracking payload assets.");
                return;
            }
            $('#vcs_global_import_file').trigger('click');
        });

        // Event listener monitoring data ingestion from imported JSON records
        $(document).off('change', '#vcs_global_import_file').on('change', '#vcs_global_import_file', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);

                    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
                        throw new Error("Invalid structure formatting: Missing entries repository context.");
                    }

                    const fileBookId = parsed.id;
                    const targetBookId = this.current.id;

                    // --- SANITY CHECK: ID Mismatch Evaluation ---
                    if (fileBookId && fileBookId !== targetBookId) {
                        const warningMsg = `Warning: The import file contains revision history designated for lorebook "${fileBookId}", but your currently open lorebook editor is tracking "${targetBookId}".\n\nProceeding will map these past revisions directly onto "${targetBookId}". Are you sure you know what you are doing?`;

                        let userConfirmed = false;
                        // Mirror ST's async modular Popup utility if accessible; fallback to blocking confirm
                        if (typeof Popup !== 'undefined' && Popup.show && Popup.show.confirm) {
                            userConfirmed = await Popup.show.confirm("VCS History Mismatch Warning", warningMsg);
                        } else {
                            userConfirmed = confirm(warningMsg);
                        }

                        if (!userConfirmed) {
                            log(`VCS: Import cancelled by user due to database target mismatch (${fileBookId} -> ${targetBookId}).`);
                            $(e.target).val('');
                            return;
                        }
                    }

                    // --- UI CLEANUP: Close all expanded entries first ---
                    log("VCS: Collapsing active UI textareas to prevent render bleed during history rewrite.");
                    $('#CloseAllWIEntries').trigger('click');

                    // Force target destination tracking context alignment
                    parsed.id = targetBookId;

                    // Parse structural records back into native extension entities
                    this.current = WorldInfo.fromJson(parsed);

                    // Update ecosystem registration index values
                    if (!this.lorebooks.includes(targetBookId)) {
                        this.lorebooks.push(targetBookId);
                        setSettings("lorebooks", this.lorebooks);
                    }

                    this.persistToStorage();
                    this.current.bind();

                    toastr.success(`Successfully imported VCS snapshot layout records into ${targetBookId}!`);
                    log(`VCS: Integrated backup tracking snapshot for ${targetBookId}`);

                    $(e.target).val('');
                } catch (err) {
                    console.error(err);
                    toastr.error(`Failed to ingest imported workspace track metadata: ${err.message}`);
                    $(e.target).val('');
                }
            };
            reader.readAsText(file);
        });
    }

    wireBindWorldSelect() {
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
    }

    wireBindEntry() {
        $(document).on('click', '.world_entry', async function() {
            const $container = $(this).find('.world_entry_edit');
            if ($container.length && !$container.data('vcs-bound')) {
                await vcs.openEditor($container);
                $container.data('vcs-bound', true);
            }
        });
    }

    wireEntryDelete() {
        document.body.addEventListener('click', function (e) {
            const targetButton = e.target.closest('.delete_entry_button');
            if (!targetButton) return;

            const worldEntry = targetButton.closest('.world_entry');
            if (!worldEntry) return;

            // Extract raw 'uid' attribute from the wrapper container
            const uid = worldEntry.getAttribute('uid');
            if (uid === undefined || uid === null) return;

            log(`VCS: Intercepted delete trigger for UID ${uid}. Monitoring for popup confirmation.`);

            // Spin up the mutation observer to look for the confirmation modal arriving
            const observer = new MutationObserver((mutations, obs) => {
                const $popup = $('dialog.popup').not('[data-vcs-delete-uid]');
                if ($popup.length) {
                    $popup.attr('data-vcs-delete-uid', uid);
                    obs.disconnect(); // De-register observer instantly once stamped
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // Safety timeout to prevent orphan memory leakage if the popup fails to load
            setTimeout(() => observer.disconnect(), 2000);
        }, true); // <-- 'true' switches listener to the Capture Phase

        /**
         * Intercepts the confirmation OK button using the same capture safety mechanism,
         * in case SillyTavern blocks propagation inside its modal layer too.
         */
        document.body.addEventListener('click', function (e) {
            const targetOk = e.target.closest('.popup-button-ok');
            if (!targetOk) return;

            const popup = targetOk.closest('dialog.popup');
            if (!popup) return;

            const deleteUid = popup.getAttribute('data-vcs-delete-uid');
            if (deleteUid !== undefined && deleteUid !== null) {
                vcs.confirmDelete(deleteUid);
            }
        }, true); // <-- 'true' switches listener to the Capture Phase
    }

    wireDeleteWorldInfo() {
        document.body.addEventListener('click', function (e) {
            const targetButton = e.target.closest('#world_popup_delete');
            if (!targetButton) return;

            // Extract active world ID tracked by manager
            const worldId = vcs.current ? vcs.current.id : null;
            if (!worldId) return;

            log(`VCS: Intercepted world delete trigger for ${worldId}. Monitoring for popup confirmation.`);

            // Spin up mutation observer to look for the confirmation modal arriving
            const observer = new MutationObserver((mutations, obs) => {
                const $popup = $('dialog.popup').not('[data-vcs-delete-world]');
                if ($popup.length && $popup.find('h3').text().includes('Delete the World/Lorebook')) {
                    $popup.attr('data-vcs-delete-world', worldId);
                    obs.disconnect(); // De-register observer instantly once stamped
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // Safety timeout to prevent orphan memory leakage if the popup fails to load
            setTimeout(() => observer.disconnect(), 2000);
        }, true); // <-- 'true' switches listener to the Capture Phase

        /**
         * Intercepts the confirmation OK button using the same capture safety mechanism,
         * in case SillyTavern blocks propagation inside its modal layer too.
         */
        document.body.addEventListener('click', function (e) {
            const targetOk = e.target.closest('.popup-button-ok');
            if (!targetOk) return;

            const popup = targetOk.closest('dialog.popup');
            if (!popup) return;

            // Check for single entry deletion tracking
            const deleteUid = popup.getAttribute('data-vcs-delete-uid');
            if (deleteUid !== undefined && deleteUid !== null) {
                vcs.confirmDelete(deleteUid);
            }

            // Check for whole world deletion tracking
            const deleteWorldId = popup.getAttribute('data-vcs-delete-world');
            if (deleteWorldId !== undefined && deleteWorldId !== null) {
                vcs.confirmDeleteWorld(deleteWorldId);
            }

        }, true); // <-- 'true' switches listener to the Capture Phase
    }

    wireRenameWorldInfo() {
        document.body.addEventListener('click', function (e) {
            const targetButton = e.target.closest('#world_popup_name_button');
            if (!targetButton) return;

            // Extract active world ID tracked by manager
            const worldId = vcs.current ? vcs.current.id : null;
            if (!worldId) return;

            log(`VCS: Intercepted world rename trigger for ${worldId}. Monitoring for popup confirmation.`);

            // Spin up mutation observer to look for the confirmation modal arriving
            const observer = new MutationObserver((mutations, obs) => {
                const $popup = $('dialog.popup').not('[data-vcs-rename-world]');
                if ($popup.length && $popup.find('h3').text().includes('Rename World Info')) {
                    $popup.attr('data-vcs-rename-world', worldId);
                    obs.disconnect(); // De-register observer instantly once stamped
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // Safety timeout to prevent orphan memory leakage if the popup fails to load
            setTimeout(() => observer.disconnect(), 2000);
        }, true); // <-- Capture Phase execution

        /**
         * Intercepts the confirmation OK button to capture the new string payload
         */
        document.body.addEventListener('click', function (e) {
            const targetOk = e.target.closest('.popup-button-ok');
            if (!targetOk) return;

            const popup = targetOk.closest('dialog.popup');
            if (!popup) return;

            const oldWorldId = popup.getAttribute('data-vcs-rename-world');
            if (oldWorldId !== undefined && oldWorldId !== null) {
                const newName = $(popup).find('.popup-input').val()?.trim();
                if (newName && oldWorldId !== newName) {
                    vcs.pendingRename = {
                        oldName: oldWorldId,
                        newName: newName,
                        timestamp: Date.now()
                    };
                    log(`VCS: Staging potential rename from ${oldWorldId} to ${newName}`);
                }
            }
        }, true); // <-- Capture Phase execution
    }
}

const vcs = new WorldInfoVCSManager();
window._debug_enerccio_vcs = vcs;

$(function () {
    // Inject our interface directly into the master entry edit template
    const $template = $('#entry_edit_template .world_entry_edit');
    if ($template.length > 0) {
        $template.prepend(REVISION_UI_HTML);
    }

    vcs.wireBindGlobalPanel();
    vcs.wireBindWorldSelect();
    vcs.wireBindEntry();
    vcs.wireEntryDelete();
    vcs.wireDeleteWorldInfo();
    vcs.wireRenameWorldInfo();
});
