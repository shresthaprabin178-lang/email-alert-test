const admin = require('firebase-admin');
console.log('credential type:', typeof admin.credential);
console.log('admin keys:', Object.keys(admin));
console.log('Has initializeApp:', typeof admin.initializeApp);
