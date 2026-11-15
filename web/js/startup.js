/* Initial scene loading: actual asset completion, retry and an explicit offline entry. */
(function () {
  const SW = (window.SW = window.SW || {});

  SW.createStartup = function (root, app) {
    const title = root.querySelector('h1');
    const message = root.querySelector('[role="status"]');
    const progress = root.querySelector('progress');
    const actions = root.querySelector('.startup-actions');
    const retry = root.querySelector('#startup-retry');
    const proceed = root.querySelector('#startup-continue');
    const states = new Map();
    let loaders, running = false, entered = false, resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    function enter() {
      if (running || entered) return;
      entered = true;
      app.inert = false;
      app.setAttribute('aria-busy', 'false');
      document.body.classList.remove('loading');
      root.hidden = true;
      resolveReady();
    }
    function render() {
      let count = 0;
      states.forEach((state, id) => {
        const row = root.querySelector(`[data-asset="${id}"]`);
        row.dataset.state = state;
        row.querySelector('b').textContent = { loading: 'Loading…', ready: 'Ready', error: 'Unavailable' }[state];
        if (state === 'ready') count++;
      });
      progress.max = states.size;
      progress.value = count;
    }
    async function start(jobs = loaders) {
      if (running || entered) return;
      loaders = jobs;
      running = true;
      root.classList.remove('error');
      actions.hidden = true;
      title.textContent = 'Preparing your sky';
      message.textContent = 'Loading Earth textures and the infrared sky map…';
      const pending = Object.entries(loaders).filter(([id]) => states.get(id) !== 'ready');
      pending.forEach(([id]) => states.set(id, 'loading'));
      render();
      await Promise.all(pending.map(async ([id, load]) => {
        try { await load(); states.set(id, 'ready'); }
        catch (_) { states.set(id, 'error'); }
        render();
      }));
      running = false;
      if ([...states.values()].every((state) => state === 'ready')) enter();
      else {
        root.classList.add('error');
        title.textContent = 'Some images could not load';
        message.textContent = 'The image servers may be slow or unreachable. Retry, or enter with the images available.';
        actions.hidden = false;
      }
    }
    function fail() {
      title.textContent = 'WebGL is unavailable';
      message.textContent = 'SpaceCam needs WebGL to display the sky. Enable graphics acceleration or try another browser.';
      root.classList.add('error');
      root.querySelector('progress').hidden = true;
      root.querySelector('.startup-assets').hidden = true;
      actions.hidden = true;
    }
    retry.onclick = () => start();
    proceed.onclick = enter;
    return { start, ready, fail };
  };
})();
