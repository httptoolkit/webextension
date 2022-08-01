/*
 * SPDX-FileCopyrightText: 2022 Tim Perry <tim@httptoolkit.tech>
 * SPDX-License-Identifier: Apache-2.0
 */

console.clear();

import * as webextension from 'webextension-polyfill';
import { print as formatQuery } from 'graphql';
import type * as Mockttp from 'mockttp';
import type * as MockRTC from 'mockrtc';
import { MockRTCRemotePeer } from 'mockrtc/dist/client/mockrtc-remote-peer';

import { getDeferred } from './utils';
import {
    HTKExtensionRequest,
    HTKExtensionResponse,
    PeerCallRequest,
    PeerMethodKeys,
    SessionCallRequest,
    SessionMethodKeys
} from './message-types';

interface InjectedConfig {
    mockRtc: {
        peerId: string;
        adminBaseUrl: string;
    } | false;
}

interface WebExtProxySettings {
    rules: {
        singleProxy?: {
            host: string,
            port: number,
            scheme: string
        }
    }
}

/**
 * Initially undefined. Becomes true if we get MockRTC config at startup.
 * If we ever get an empty config (meaning MockRTC is explicitly disabled)
 * then this becomes false, and the extension is disabled until the browser
 * (or the extension) is restarted.
 */
let isActive: true | false | undefined = undefined;

let mockPeerPromise = getDeferred<MockRTC.MockRTCPeer>();

type RealAdminClient = Mockttp.PluggableAdmin.AdminClient<{}>;

class MinimalAdminClient {

    constructor(
        private baseUrl: string
    ) {}

    async sendQuery<Response, Result = Response>(
        builtQuery: MockRTC.PluggableAdmin.AdminQuery<Response, Result>
    ): Promise<Result> {
        const { query, variables, transformResponse } = builtQuery;

        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: new Headers({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({
                query: formatQuery(query),
                variables
            })
        });

        const result = await response.json();

        if (result.errors?.length) {
            console.error(result.errors);
            throw new Error('Unexpected GraphQL errors');
        }

        const data = result.data;

        return transformResponse
            ? transformResponse(data, {
                adminClient: this as unknown as RealAdminClient
            })
            : result;
    }

}

/**
 * To get access to the MockRTC peer for connection setup, we need the URL and peer id for MockRTC.
 * HTTP Toolkit has these, but needs to communicate them somehow into this extension.
 *
 * To make this more complicated, from a single extension directory, we may be intercepting many
 * browsers for many different proxy ports on a single machine. It's not possible to directly
 * pass arguments into the webextension at startup, so this is challenging.
 *
 * To handle this, we use the proxy configuration of this browser instance as a key, and write the
 * config arguments for this extension to a file in the extension directory, under that key.
 *
 * Once we have the config settings, we can then build a MockRTC peer from the given URL and peer id,
 * and use that to do the subsequent MockRTC interception steps.
 */
async function updateMockRTCPeerConnection() {
    try {
        const config: { value?: WebExtProxySettings } = await webextension.proxy.settings.get({});
        const singleProxySetting = config?.value?.rules?.singleProxy;

        if (!singleProxySetting) {
            throw new Error("Could not detect Chrome proxy settings, can't intercept WebRTC");
        }

        const proxyAddress = `${singleProxySetting.host}:${singleProxySetting.port}`;

        // Get a filesystem-safe key from this address, i.e. no colons.
        const configKey = proxyAddress
            .replace(/\./g, '_')
            .replace(/:/g, '.'); // -> 127_0_0_1.8000

        const configPath = webextension.runtime.getURL(`/config/${configKey}`);

        const htkConfig: InjectedConfig = await fetch(configPath)
            .then(r => r.json())
            .catch((e) => {
                console.warn(e);
                throw new Error(`No WebExtension config available for ${configKey}`);
            });

        if (htkConfig.mockRtc === false) {
            shutdown();
            return;
        }

        const adminClient = new MinimalAdminClient(htkConfig.mockRtc.adminBaseUrl) as
            unknown as MockRTC.PluggableAdmin.AdminClient<{}>;

        mockPeerPromise.resolve(new MockRTCRemotePeer(htkConfig.mockRtc.peerId, adminClient));
        isActive = true;
        console.log('HTTP Toolkit extension initialised');
    } catch (e) {
        // Some general error happened - we're not active, but we don't shut down until we
        // explicitly get config that says to do so.
        isActive = undefined;

        // On unrecognized errors, wait a second, then try again, until we get a real config,
        // or we explicitly shut down.
        await new Promise((resolve) => setTimeout(resolve, 1000))
            .then(() => updateMockRTCPeerConnection());
    }
}


async function recoverAfterFailure() {
    if (isActive === false) throw new Error('MockRTC interception disabled');

    // If we somehow call this after another failure/before setup completes, wait
    // for the other failure case.
    if (isActive === undefined) return mockPeerPromise;

    mockPeerPromise = getDeferred<MockRTC.MockRTCPeer>();
    isActive = undefined;

    while (isActive === undefined) {
        await updateMockRTCPeerConnection();
    }
}

function shutdown() {
    isActive = false; // Block all future calls

    const shutdownError = new Error('MockRTC interception disabled');

    // If the peer promise is pending, reject it:
    mockPeerPromise.reject(shutdownError);
    // Just in case it wasn't, create a new one, and reject that too:
    mockPeerPromise = getDeferred<MockRTC.MockRTCPeer>();
    mockPeerPromise.reject(shutdownError);

    // Stop injecting into pages:
    webextension.scripting.unregisterContentScripts();
}

// Set up the MockRTC peer connection, if possible, and start injecting into pages:
updateMockRTCPeerConnection().then(async () => {
    if (!isActive) {
        console.log("WebRTC mocking disabled");
        return;
    }

    // If and only if we eventually manage to load a useful config, we start injecting
    // the content scripts into every loaded frame:
    await webextension.scripting.unregisterContentScripts();
    await webextension.scripting.registerContentScripts([
        {
            id: 'rtc-content-script',
            matches: ['<all_urls>'],
            persistAcrossSessions: false,
            allFrames: true,
            js: ['build/content-script.js']
        }
    ]);
});

// Methods that map to/from messages from injected scripts to calls to our
// mock RTC peer:

async function runPeerMethod<M extends PeerMethodKeys>(
    request: PeerCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCPeer[M]>> {
    if (isActive === false) throw new Error('MockRTC interception disabled');

    try {
        const { methodName, args } = request;
        const peer = await mockPeerPromise;

        return await (peer[methodName] as any).apply(peer, args);
    } catch (e) {
        console.log(e);
        await recoverAfterFailure();
        return runPeerMethod(request);
    }
}

async function runSessionMethod<M extends SessionMethodKeys>(
    request: SessionCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCSession[M]>> {
    if (isActive === false) throw new Error('MockRTC interception disabled');

    try {
        const { sessionId, methodName, args } = request;
        const peer = await mockPeerPromise;
        const session = peer.getSession(sessionId);
        return await (session[methodName] as any).apply(session, args);
    } catch (e) {
        console.log(e);
        await recoverAfterFailure();
        return runSessionMethod(request);
    }
}

webextension.runtime.onMessage.addListener(((
    message: HTKExtensionRequest,
    _sender: any,
    sendMessage: (msg: HTKExtensionResponse) => void
) => {
    (async () => {
        console.debug('request', message);
        try {
            switch (message.type) {
                case 'peer:method':
                    const peerResult = await runPeerMethod(message);

                    // We strip the session to just the id, to avoid exposing the adminClient
                    // or any other unnecessary details. Not good to share the mock session id
                    // with pages as with that malicious pages could actively reconfigure it!
                    (peerResult as any).session = { sessionId: peerResult.session.sessionId }
                    delete (peerResult as any).setAnswer;

                    return {
                        type: 'result',
                        result: peerResult
                    } as const;
                case 'session:method':
                    const sessionResult = (await runSessionMethod(message))!;
                    return {
                        type: 'result',
                        result: sessionResult
                    } as const;
            }
        } catch (e: any) {
            console.warn(e);
            return { type: 'error', message: e.message ?? e } as const;
        }
    })().then((result) => {
        console.debug('response', result);
        sendMessage(result);
    });

    // In Firefox, we could just return the above as a promise here and we'd be golden.
    // Unfortunately that doesn't work in Chrome, so instead we have to use sendMessage and
    // return true here to allow async responses:
    return true;
}) as any);
