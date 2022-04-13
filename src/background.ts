import * as webextension from 'webextension-polyfill';
import * as MockRTC from 'mockrtc';

const server = MockRTC.getRemote();

webextension.runtime.onInstalled.addListener(async () => {
    await server.start();
    console.log('Mock session started');
});