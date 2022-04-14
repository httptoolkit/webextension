console.clear();

import * as webextension from 'webextension-polyfill';
import * as MockRTC from 'mockrtc';

import {
    HTKExtensionRequest,
    HTKExtensionResponse,
    PeerCallRequest,
    PeerMethodKeys,
    SessionCallRequest,
    SessionMethodKeys
} from './message-types';

const server = MockRTC.getRemote();
server.start().then(() => {
    peerPromise = server.buildPeer().thenPassThrough();

    peerPromise.then(() => {
        console.log('HTTP Toolkit extension initialised');
    });
});

let peerPromise: Promise<MockRTC.MockRTCPeer>;

async function runPeerMethod<M extends PeerMethodKeys>(
    request: PeerCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCPeer[M]>> {
    const { methodName, args } = request;
    const peer = await peerPromise;
    return (peer[methodName] as any).apply(peer, args);
}

async function runSessionMethod<M extends SessionMethodKeys>(
    request: SessionCallRequest<M>
): Promise<ReturnType<MockRTC.MockRTCSession[M]>> {
    const { sessionId, methodName, args } = request;
    const peer = await peerPromise;
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
                    // with pages as with that they could actively reconfigure it!
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
