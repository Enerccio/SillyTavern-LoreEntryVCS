import {EXTENSION_NAME, MODULE_NAME} from "./conf.js";
import {debounce} from '/scripts/utils.js';
import {extension_settings} from "/scripts/extensions.js";
import {saveSettingsDebounced} from "/script.js";

export function log() {
    console.log(`[${EXTENSION_NAME}]`, ...arguments);
}

export function error() {
    console.error(`[${EXTENSION_NAME}]`, ...arguments);
}

export function errorToast() {
    console.error(`[${EXTENSION_NAME}]`, ...arguments);
    toastr.error(Array.from(arguments).join(' '), EXTENSION_NAME);
}

export function toast(message, type="info") {
    // debounce the toast messages
    // noinspection JSUnresolvedReference
    toastr[type](message, EXTENSION_NAME);
}

export const toastDebounced = debounce(toast, 500);

export function setSettings(key, value, copy=false) {
    // Set a setting for the extension and save it
    if (copy) {
        value = structuredClone(value)
    }
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

export function getSettings(key, copy=false, defval = "") {
    // Get a setting for the extension, or the default value if not set
    let value = extension_settings[MODULE_NAME]?.[key] ?? defval;
    if (copy) {  // needed when retrieving objects
        return structuredClone(value)
    } else {
        return value
    }
}

export function delSetting(key) {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    delete extension_settings[MODULE_NAME][key];
    saveSettingsDebounced();
}
