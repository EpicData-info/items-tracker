require('dotenv').config({ path: `${__dirname}/.env` });
const Fs = require('fs');
const SimpleGit = require('simple-git');
const Axios = require('axios');
const { Launcher } = require('epicgames-client');

class Main {
  constructor () {
    this.language = 'en';
    this.country = 'US';
    this.namespaces = [];
    this.perPage = 1000;
    this.trackingStats = {
      timeUnit: 'ms',
    };
    this.databasePath = `${__dirname}/database`;

    this.launcher = new Launcher({
      useWaitingRoom: false,
      useCommunicator: false,
    });
    this.launcher.init().then(() => {
      this.update();
    });
  }

  async fetchNamespaces () {
    if (!process.env.NAMESPACES_URL) {
      throw new Error('No enviroment variable NAMESPACES_URL');
    }
    const { data } = await Axios.get(process.env.NAMESPACES_URL, {
      responseType: 'json',
    });
    this.namespaces = Object.keys(data);
  }

  async update () {
    let checkpointTime;
    await this.fetchNamespaces();
    
    checkpointTime = Date.now();
    for (let i = 0; i < this.namespaces.length; ++i) {
      const namespace = this.namespaces[i];
      console.log(`Updating items for namespace ${namespace}...`);
      await this.fetchAllItemsForNamespace(namespace);
    }
    this.trackingStats.fetchItemsTime = Date.now() - checkpointTime;

    this.launcher.logout();
    
    checkpointTime = Date.now();
    this.index();
    this.trackingStats.indexTime = Date.now() - checkpointTime;

    this.trackingStats.lastUpdate = Date.now();
    this.trackingStats.lastUpdateString = (new Date(this.trackingStats.lastUpdate)).toISOString();

    await this.sync();
    process.exit(0);
  }
  
  index () {
    console.log('Indexing...');
    const namespaces = {};
    const titles = {};
    
    const itemsPath = `${this.databasePath}/items`;
    Fs.readdirSync(itemsPath).forEach((fileName) => {
      if (fileName.substr(-5) !== '.json') return;
      try {
        const item = JSON.parse(Fs.readFileSync(`${itemsPath}/${fileName}`));
        if (item.namespace) {
          if (!namespaces[item.namespace]) {
            namespaces[item.namespace] = [item.id];
          } else {
            namespaces[item.namespace].push(item.id);
          }
        }
        titles[item.id] = item.title;
      } catch (error) {
        console.error(error);
      }
    });
    
    Fs.writeFileSync(`${this.databasePath}/namespaces.json`, JSON.stringify(namespaces, null, 2));
    Fs.writeFileSync(`${this.databasePath}/titles.json`, JSON.stringify(titles, null, 2));
  }

  async sync () {
    if (!process.env.GIT_REMOTE) return;
    console.log('Syncing with repo...');
    const git = SimpleGit({
      baseDir: __dirname,
      binary: 'git',
    });
    await git.addConfig('hub.protocol', 'https');
    await git.checkoutBranch('master');
    await git.add([`${this.databasePath}/.`]);
    const status = await git.status();
    const changesCount = status.created.length + status.modified.length + status.deleted.length + status.renamed.length;
    if (changesCount === 0) return;
    Fs.writeFileSync(`${this.databasePath}/tracking-stats.json`, JSON.stringify(this.trackingStats, null, 2));
    await git.add([`${this.databasePath}/.`]);
    const commitMessage = `Update - ${new Date().toISOString()}`;
    await git.commit(commitMessage);
    await git.removeRemote('origin');
    await git.addRemote('origin', process.env.GIT_REMOTE);
    await git.push(['-u', 'origin', 'master']);
    console.log(`Changes has commited to repo with message ${commitMessage}`);
  }
  
  saveItem (item) {
    try {
      Fs.writeFileSync(`${__dirname}/database/items/${item.id}.json`, JSON.stringify(item, null, 2));
    } catch (error) {
      console.log(`${item.id} = ERROR`);
      console.error(error);
    }
  }

  sleep (time) {
    return new Promise((resolve) => {
      const sto = setTimeout(() => {
        clearTimeout(sto);
        resolve();
      }, time);
    });
  }

  async fetchAllItemsForNamespace (namespace) {
    let paging = {};
    do {
      const result = await this.fetchItemsForNamespace(namespace, paging.start, paging.count || this.perPage);
      paging = result.paging;
      paging.start += paging.count;
      for (let i = 0; i < result.elements.length; ++i) {
        const element = result.elements[i];
        this.saveItem(element);
      }
    } while (paging.start - this.perPage < paging.total - paging.count);
  }

  async fetchItemsForNamespace (namespace, start = 0, count = 1000) {
    try {
      const { data } = await this.launcher.http.sendGet(`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`);
      return data;
    } catch (error) {
      if (error.response) {
        if (error.response.data) {
          const result = error.response.data;
          if (result && result.elements && result.paging) {
            return result;
          }
        }
        console.log(JSON.stringify(error.response, null, 2));
        console.log('Next attempt in 1s...');
        await this.sleep(1000);
        return this.fetchItemsForNamespace(...arguments);
      } else {
        throw new Error(error);
      }
    }
  }
}

module.exports = new Main();
