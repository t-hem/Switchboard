const [major, minor] = process.versions.node.split('.').map(Number);
if (process.platform !== 'linux' || major !== 22 || minor !== 23) {
  console.error(`Jobs tests require Linux and Node 22.23.x (found ${process.platform}, Node ${process.versions.node}). Run: nvm install 22.23.2 && nvm use 22.23.2`);
  process.exit(1);
}
