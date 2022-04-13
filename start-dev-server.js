const mockrtc = require('mockrtc');
mockrtc.getAdminServer().start().then(() => {
    console.log('MockRTC admin server started');
});