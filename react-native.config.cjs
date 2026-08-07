module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.alaznah.calling.AlaznahCallingPackage;',
        packageInstance: 'new AlaznahCallingPackage()',
      },
      ios: {},
    },
  },
};
