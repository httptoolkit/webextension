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
        mockRtcUrl: string;
    };
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

const mockPeerPromise = getDeferred<MockRTC.MockRTCPeer>();

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
webextension.proxy.settings.get({}).then(async (config: { value: WebExtProxySettings }) => {
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
            throw new Error(`Failed to load WebExtension config for ${configKey}`);
        });

    const adminClient = new MinimalAdminClient(htkConfig.mockRtc.mockRtcUrl) as
        unknown as MockRTC.PluggableAdmin.AdminClient<{}>;

    mockPeerPromise.resolve(new MockRTCRemotePeer(htkConfig.mockRtc.peerId, adminClient));
    console.log('HTTP Toolkit extension initialised');
});

async function runPeerMethod<M extends PeerMethodKeys>(
    request: PeerCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCPeer[M]>> {
    const { methodName, args } = request;
    const peer = await mockPeerPromise;
    return (peer[methodName] as any).apply(peer, args);
}

async function runSessionMethod<M extends SessionMethodKeys>(
    request: SessionCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCSession[M]>> {
    const { sessionId, methodName, args } = request;
    const peer = await mockPeerPromise;
    const session = peer.getSession(sessionId);
    return (session[methodName] as any).apply(session, args);
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
