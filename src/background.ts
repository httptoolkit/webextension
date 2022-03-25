import * as webextension from 'webextension-polyfill';

webextension.runtime.onInstalled.addListener(() => {
    console.log('Installed!');
});