import { expect } from '@open-wc/testing';
import {
  applyPersistedLocale,
  settingsStore,
  getGraphColorSchemes,
  getDiffWhitespaceModes,
  DIFF_WHITESPACE_MODES,
  clampDiffContextLines,
  MIN_DIFF_CONTEXT_LINES,
  MAX_DIFF_CONTEXT_LINES,
  migrateSettings,
  watchSystemContrast,
} from '../settings.store.ts';
import type { SettingsState } from '../settings.store.ts';
import { detectSystemLocale } from '../../i18n/index.ts';

describe('settings.store', () => {
  beforeEach(() => {
    settingsStore.getState().resetToDefaults();
  });

  describe('clampDiffContextLines', () => {
    it('keeps in-range integers untouched', () => {
      expect(clampDiffContextLines(0)).to.equal(MIN_DIFF_CONTEXT_LINES);
      expect(clampDiffContextLines(3)).to.equal(3);
      expect(clampDiffContextLines(20)).to.equal(MAX_DIFF_CONTEXT_LINES);
    });

    it('clamps out-of-range values to the bounds', () => {
      expect(clampDiffContextLines(-1)).to.equal(MIN_DIFF_CONTEXT_LINES);
      expect(clampDiffContextLines(21)).to.equal(MAX_DIFF_CONTEXT_LINES);
    });

    it('falls back to git’s default for a non-numeric value', () => {
      expect(clampDiffContextLines(Number.NaN)).to.equal(3);
      expect(clampDiffContextLines(Number.POSITIVE_INFINITY)).to.equal(3);
    });
  });

  describe('initial state / defaults', () => {
    it('should have dark theme by default', () => {
      expect(settingsStore.getState().theme).to.equal('dark');
    });

    it('should have medium font size by default', () => {
      expect(settingsStore.getState().fontSize).to.equal('medium');
    });

    it('should have comfortable density by default', () => {
      expect(settingsStore.getState().density).to.equal('comfortable');
    });

    it('should have main as default branch name', () => {
      expect(settingsStore.getState().defaultBranchName).to.equal('main');
    });

    it('no longer exposes a default remote name', () => {
      // Removed rather than wired: fetch/pull/push resolve their remote from
      // the branch's upstream and git's push config, so an app-level default
      // would only ever override that resolution.
      const state = settingsStore.getState() as unknown as Record<string, unknown>;
      expect(state).to.not.have.property('defaultRemoteName');
      expect(state).to.not.have.property('setDefaultRemoteName');
    });

    it('should have empty default clone path by default', () => {
      expect(settingsStore.getState().defaultClonePath).to.equal('');
    });

    it('should NOT show avatars by default', () => {
      // Avatars are images fetched from gravatar.com, which hands a third
      // party an MD5 of every commit author's email. Opt-in, not opt-out.
      expect(settingsStore.getState().showAvatars).to.be.false;
    });

    it('should show commit size by default', () => {
      expect(settingsStore.getState().showCommitSize).to.be.true;
    });

    it('should have 3 diff context lines by default', () => {
      expect(settingsStore.getState().diffContextLines).to.equal(3);
    });

    it('should have word wrap disabled by default', () => {
      // The diff view's own copy — the only word wrap that ever did anything —
      // defaulted to off, so this default must match it.
      expect(settingsStore.getState().wordWrap).to.be.false;
    });

    it('should not ignore any whitespace by default', () => {
      // 'none' is what every diff has always rendered, so it must stay the
      // default when the setting became live.
      expect(settingsStore.getState().diffIgnoreWhitespace).to.equal('none');
    });

    it('should have auto fetch disabled by default', () => {
      expect(settingsStore.getState().autoFetchInterval).to.equal(0);
    });

    it('should have fetch on focus disabled by default', () => {
      expect(settingsStore.getState().fetchOnFocus).to.be.false;
    });

    it('should confirm before discard by default', () => {
      expect(settingsStore.getState().confirmBeforeDiscard).to.be.true;
    });

    it('should open last repository by default', () => {
      expect(settingsStore.getState().openLastRepository).to.be.true;
    });

    it('should have auto stash on checkout enabled by default', () => {
      // Until the setting was wired through, every checkout auto-stashed
      // regardless. Defaulting to false would have silently turned a seamless
      // branch switch into a refusal for every existing user.
      expect(settingsStore.getState().autoStashOnCheckout).to.be.true;
    });

    it('should not always sign off by default', () => {
      // Sign-off is a project requirement, not a universal one: defaulting it
      // on would add a trailer to every commit message unasked.
      expect(settingsStore.getState().alwaysSignOff).to.be.false;
    });

    it('should have 90 stale branch days by default', () => {
      expect(settingsStore.getState().staleBranchDays).to.equal(90);
    });

    it('should have 300s network timeout by default', () => {
      expect(settingsStore.getState().networkOperationTimeout).to.equal(300);
    });

    it('should not minimize to tray by default', () => {
      expect(settingsStore.getState().minimizeToTray).to.be.false;
    });

    it('should show native notifications by default', () => {
      expect(settingsStore.getState().showNativeNotifications).to.be.true;
    });
  });

  describe('setters', () => {
    it('should set theme to light', () => {
      settingsStore.getState().setTheme('light');
      expect(settingsStore.getState().theme).to.equal('light');
    });

    it('should set theme to system', () => {
      settingsStore.getState().setTheme('system');
      expect(settingsStore.getState().theme).to.equal('system');
    });

    it('should apply theme to document element', () => {
      settingsStore.getState().setTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).to.equal('light');
    });

    it('should set density to compact', () => {
      settingsStore.getState().setDensity('compact');
      expect(settingsStore.getState().density).to.equal('compact');
    });

    it('should set density to spacious', () => {
      settingsStore.getState().setDensity('spacious');
      expect(settingsStore.getState().density).to.equal('spacious');
    });

    it('should apply density to document element', () => {
      settingsStore.getState().setDensity('compact');
      expect(document.documentElement.getAttribute('data-density')).to.equal('compact');
    });

    it('should set graph color scheme', () => {
      settingsStore.getState().setGraphColorScheme('vibrant');
      expect(settingsStore.getState().graphColorScheme).to.equal('vibrant');
    });

    it('should apply graph color scheme to document', () => {
      settingsStore.getState().setGraphColorScheme('pastel');
      expect(document.documentElement.getAttribute('data-graph-scheme')).to.equal('pastel');
    });

    it('should set offline mode', () => {
      settingsStore.getState().setOfflineMode(true);
      expect(settingsStore.getState().offlineMode).to.be.true;
    });

    it('should set confirm network ops', () => {
      settingsStore.getState().setConfirmNetworkOps(true);
      expect(settingsStore.getState().confirmNetworkOps).to.be.true;
    });

    it('should set remote allowlist', () => {
      settingsStore.getState().setRemoteAllowlist(['github.com', 'gitlab.com']);
      expect(settingsStore.getState().remoteAllowlist).to.deep.equal(['github.com', 'gitlab.com']);
    });

    it('should set font size', () => {
      settingsStore.getState().setFontSize('large');
      expect(settingsStore.getState().fontSize).to.equal('large');
    });

    it('should set font family', () => {
      settingsStore.getState().setFontFamily('monospace');
      expect(settingsStore.getState().fontFamily).to.equal('monospace');
    });

    it('should set default branch name', () => {
      settingsStore.getState().setDefaultBranchName('master');
      expect(settingsStore.getState().defaultBranchName).to.equal('master');
    });

    it('should set default clone path', () => {
      settingsStore.getState().setDefaultClonePath('/home/user/projects');
      expect(settingsStore.getState().defaultClonePath).to.equal('/home/user/projects');
    });

    it('should set show avatars', () => {
      settingsStore.getState().setShowAvatars(true);
      expect(settingsStore.getState().showAvatars).to.be.true;
      settingsStore.getState().setShowAvatars(false);
      expect(settingsStore.getState().showAvatars).to.be.false;
    });

    it('should set show commit size', () => {
      settingsStore.getState().setShowCommitSize(false);
      expect(settingsStore.getState().showCommitSize).to.be.false;
    });

    it('should set graph row height', () => {
      settingsStore.getState().setGraphRowHeight(50);
      expect(settingsStore.getState().graphRowHeight).to.equal(50);
    });

    it('should set diff context lines', () => {
      settingsStore.getState().setDiffContextLines(5);
      expect(settingsStore.getState().diffContextLines).to.equal(5);
    });

    it('should clamp diff context lines into range', () => {
      settingsStore.getState().setDiffContextLines(999);
      expect(settingsStore.getState().diffContextLines).to.equal(MAX_DIFF_CONTEXT_LINES);

      settingsStore.getState().setDiffContextLines(-4);
      expect(settingsStore.getState().diffContextLines).to.equal(MIN_DIFF_CONTEXT_LINES);

      // A cleared number input yields NaN; fall back to git's default.
      settingsStore.getState().setDiffContextLines(Number.NaN);
      expect(settingsStore.getState().diffContextLines).to.equal(3);

      settingsStore.getState().setDiffContextLines(4.7);
      expect(settingsStore.getState().diffContextLines).to.equal(4);
    });

    it('should set word wrap', () => {
      settingsStore.getState().setWordWrap(false);
      expect(settingsStore.getState().wordWrap).to.be.false;
    });

    it('should set the diff whitespace mode', () => {
      settingsStore.getState().setDiffIgnoreWhitespace('all');
      expect(settingsStore.getState().diffIgnoreWhitespace).to.equal('all');

      settingsStore.getState().setDiffIgnoreWhitespace('none');
      expect(settingsStore.getState().diffIgnoreWhitespace).to.equal('none');
    });

    it('should set auto fetch interval', () => {
      settingsStore.getState().setAutoFetchInterval(5);
      expect(settingsStore.getState().autoFetchInterval).to.equal(5);
    });

    it('should set fetch on focus', () => {
      settingsStore.getState().setFetchOnFocus(true);
      expect(settingsStore.getState().fetchOnFocus).to.be.true;
    });

    it('should set confirm before discard', () => {
      settingsStore.getState().setConfirmBeforeDiscard(false);
      expect(settingsStore.getState().confirmBeforeDiscard).to.be.false;
    });

    it('should set open last repository', () => {
      settingsStore.getState().setOpenLastRepository(false);
      expect(settingsStore.getState().openLastRepository).to.be.false;
    });

    it('should set auto stash on checkout', () => {
      settingsStore.getState().setAutoStashOnCheckout(true);
      expect(settingsStore.getState().autoStashOnCheckout).to.be.true;
    });

    it('should set always sign off', () => {
      settingsStore.getState().setAlwaysSignOff(true);
      expect(settingsStore.getState().alwaysSignOff).to.be.true;
    });

    it('should set stale branch days', () => {
      settingsStore.getState().setStaleBranchDays(30);
      expect(settingsStore.getState().staleBranchDays).to.equal(30);
    });

    it('should set network operation timeout', () => {
      settingsStore.getState().setNetworkOperationTimeout(60);
      expect(settingsStore.getState().networkOperationTimeout).to.equal(60);
    });

    it('should set minimize to tray', () => {
      settingsStore.getState().setMinimizeToTray(true);
      expect(settingsStore.getState().minimizeToTray).to.be.true;
    });

    it('should set show native notifications', () => {
      settingsStore.getState().setShowNativeNotifications(false);
      expect(settingsStore.getState().showNativeNotifications).to.be.false;
    });
  });

  describe('resetToDefaults', () => {
    it('should reset all settings to defaults', () => {
      settingsStore.getState().setFontSize('large');
      settingsStore.getState().setAutoFetchInterval(10);
      settingsStore.getState().setConfirmBeforeDiscard(false);

      settingsStore.getState().resetToDefaults();

      expect(settingsStore.getState().fontSize).to.equal('medium');
      expect(settingsStore.getState().autoFetchInterval).to.equal(0);
      expect(settingsStore.getState().confirmBeforeDiscard).to.be.true;
    });

    it('should reset theme to dark', () => {
      settingsStore.getState().setTheme('light');
      settingsStore.getState().resetToDefaults();
      expect(settingsStore.getState().theme).to.equal('dark');
    });

    it('should reset density to comfortable', () => {
      settingsStore.getState().setDensity('compact');
      settingsStore.getState().resetToDefaults();
      expect(settingsStore.getState().density).to.equal('comfortable');
    });

    it('should reset graph color scheme to default', () => {
      settingsStore.getState().setGraphColorScheme('vibrant');
      settingsStore.getState().resetToDefaults();
      expect(settingsStore.getState().graphColorScheme).to.equal('default');
    });

    it('should reset default clone path', () => {
      settingsStore.getState().setDefaultClonePath('/some/path');
      settingsStore.getState().resetToDefaults();
      expect(settingsStore.getState().defaultClonePath).to.equal('');
    });

    it('should reset security settings', () => {
      settingsStore.getState().setOfflineMode(true);
      settingsStore.getState().setConfirmNetworkOps(true);
      settingsStore.getState().setRemoteAllowlist(['github.com']);

      settingsStore.getState().resetToDefaults();

      expect(settingsStore.getState().offlineMode).to.be.false;
      expect(settingsStore.getState().confirmNetworkOps).to.be.false;
      expect(settingsStore.getState().remoteAllowlist).to.deep.equal([]);
    });

    it('should re-apply DOM side effects on reset', () => {
      settingsStore.getState().setTheme('light');
      settingsStore.getState().setDensity('compact');
      settingsStore.getState().resetToDefaults();
      expect(document.documentElement.getAttribute('data-theme')).to.equal('dark');
      expect(document.documentElement.getAttribute('data-density')).to.equal('comfortable');
    });
  });

  describe('persistence', () => {
    it('should use gitnado-settings as storage key', () => {
      settingsStore.getState().setFontSize('large');
      const stored = localStorage.getItem('gitnado-settings');
      expect(stored).to.be.a('string');
      expect(stored).to.not.be.null;
    });

    it('should store changed values in localStorage', () => {
      settingsStore.getState().setAutoFetchInterval(15);
      const stored = JSON.parse(localStorage.getItem('gitnado-settings')!);
      expect(stored.state.autoFetchInterval).to.equal(15);
    });
  });

  describe('getGraphColorSchemes', () => {
    it('should return all available schemes', () => {
      const schemes = getGraphColorSchemes();
      expect(schemes).to.have.lengthOf(5);
    });

    it('should include default scheme', () => {
      const schemes = getGraphColorSchemes();
      expect(schemes.some(s => s.id === 'default')).to.be.true;
    });

    it('should include high-contrast scheme', () => {
      const schemes = getGraphColorSchemes();
      expect(schemes.some(s => s.id === 'high-contrast')).to.be.true;
    });

    it('should have colors for each scheme', () => {
      const schemes = getGraphColorSchemes();
      for (const scheme of schemes) {
        expect(scheme.colors).to.be.an('array');
        expect(scheme.colors.length).to.be.greaterThan(0);
      }
    });

    it('should have names for each scheme', () => {
      const schemes = getGraphColorSchemes();
      for (const scheme of schemes) {
        expect(scheme.name).to.be.a('string');
        expect(scheme.name.length).to.be.greaterThan(0);
      }
    });
  });

  describe('getDiffWhitespaceModes', () => {
    it('offers the same modes, in the same order, as the source-locale list', () => {
      // Two lists exist only because the diff view's own toolbar has not been
      // migrated to msg() yet. They must never drift apart.
      expect(getDiffWhitespaceModes().map((m) => m.value)).to.deep.equal(
        DIFF_WHITESPACE_MODES.map((m) => m.value)
      );
    });

    it('labels every mode in the active locale (English by default)', () => {
      expect(getDiffWhitespaceModes()).to.deep.equal(DIFF_WHITESPACE_MODES);
    });
  });

  describe('applyPersistedLocale', () => {
    afterEach(async () => {
      await settingsStore.getState().setLanguage('en');
    });

    it('writes back the locale that actually rendered', async () => {
      // A locale we no longer ship (or whose templates fail to load) must not
      // survive in storage: Settings would keep naming a language the UI is
      // not in. Written straight into state to stand in for such a blob.
      settingsStore.setState({ language: 'de' as unknown as SettingsState['language'] });

      const applied = await applyPersistedLocale();

      expect(applied, 'the locale that ended up active').to.equal('en');
      expect(settingsStore.getState().language, 'corrected in storage').to.equal('en');
    });

    it('leaves a locale we do ship alone', async () => {
      settingsStore.setState({ language: 'en' });

      expect(await applyPersistedLocale()).to.equal('en');
      expect(settingsStore.getState().language).to.equal('en');
    });
  });

  describe('persisted-state migration', () => {
    it('v1 state carries autoStashOnCheckout forward as true', () => {
      // Changing a default only reaches installs with NO persisted state, and
      // zustand shallow-merges the persisted object over the defaults — so
      // every user who had ever changed any setting kept the old `false` and
      // still got a refused checkout. That `false` was never a choice: nothing
      // read the setting until it was wired up.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate;
      expect(migrate, 'a migration exists').to.not.be.undefined;

      const migrated = migrate!({ theme: 'dark', autoStashOnCheckout: false }, 1) as {
        autoStashOnCheckout: boolean;
        theme: string;
      };

      expect(migrated.autoStashOnCheckout).to.equal(true);
      expect(migrated.theme, 'other settings survive').to.equal('dark');
      expect(
        (migrated as unknown as { wordWrap: boolean }).wordWrap,
        'the never-read value is dropped'
      ).to.equal(false);
    });

    it('leaves a v2 state alone', () => {
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ autoStashOnCheckout: false }, 2) as {
        autoStashOnCheckout: boolean;
      };

      expect(migrated.autoStashOnCheckout, 'a v2 false is a real user choice').to.equal(false);
    });

    it('a v2 wordWrap is dropped — nothing read it', () => {
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ wordWrap: true, autoStashOnCheckout: false }, 2) as {
        wordWrap: boolean;
        autoStashOnCheckout: boolean;
      };

      expect(migrated.wordWrap, 'a persisted wordWrap was never a user choice').to.equal(false);
      expect(migrated.autoStashOnCheckout, 'a v2 false is a real user choice').to.equal(false);
    });

    it('a pre-v5 state keeps a persisted showAvatars choice', () => {
      // The v5 default flip (true -> false) must not reach anyone who already
      // has settings: avatars were always drawn, so a persisted value IS a
      // real user choice. zustand's shallow merge preserves it and the
      // migration must not overwrite it.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      expect((migrate({ showAvatars: true }, 3) as { showAvatars: boolean }).showAvatars).to.equal(
        true
      );
      expect((migrate({ showAvatars: false }, 3) as { showAvatars: boolean }).showAvatars).to.equal(
        false
      );
    });

    it('a pre-v5 state with no showAvatars key gets the OLD default', () => {
      // Such a state predates the key and was rendered with the old default
      // of `true`; keep showing what those users saw rather than silently
      // switching avatars off under them.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ theme: 'light' }, 3) as {
        showAvatars: boolean;
        theme: string;
      };
      expect(migrated.showAvatars).to.equal(true);
      expect(migrated.theme, 'other settings survive').to.equal('light');
    });

    it('a v4 state with no showAvatars key still gets the OLD default', () => {
      // v4 was the last version whose default was `true`, so an absent key
      // there means what it meant at v3: that user saw avatars.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ theme: 'light' }, 4) as { showAvatars?: boolean };
      expect(migrated.showAvatars).to.equal(true);
    });

    it('a v5 state is left to the store default', () => {
      // v5 onwards the key is always written with the new default, so an
      // absent one is not a pre-existing choice and must fall through.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ theme: 'light' }, 5) as { showAvatars?: boolean };
      expect(migrated.showAvatars, 'left to the store default').to.equal(undefined);
    });

    it('drops a persisted defaultRemoteName — the setting no longer exists', () => {
      // Nothing ever read it; which remote fetch/pull/push contact comes from
      // git's own config, so the key is stale rather than a user choice.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ defaultRemoteName: 'upstream', theme: 'light' }, 3) as Record<
        string,
        unknown
      >;

      expect(migrated).to.not.have.property('defaultRemoteName');
      expect(migrated.theme, 'other settings survive').to.equal('light');
    });

    it('leaves a v4 state alone apart from the dead remote key', () => {
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate(
        { wordWrap: true, theme: 'light', defaultRemoteName: 'upstream' },
        4
      ) as Record<string, unknown>;

      expect(migrated.wordWrap, 'a v4 value is a real user choice').to.equal(true);
      expect(migrated.theme).to.equal('light');
      expect(migrated, 'the v7 rule still runs at v4').to.not.have.property('defaultRemoteName');
    });

    it('applies every rule in order for a v1 install upgrading straight to v8', () => {
      // The oldest persisted blob we support has to come out the other end with
      // every rule applied: auto-stash forced on, the never-read wordWrap
      // dropped, the graph scheme un-pinned because it was never chosen, the
      // old avatar default filled in, the whitespace mode seeded, the dead
      // remote key gone, and the UI language pinned to the English these
      // installs have always rendered in.
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate(
        {
          autoStashOnCheckout: false,
          wordWrap: true,
          graphColorScheme: 'default',
          defaultRemoteName: 'upstream',
          theme: 'light',
        },
        1
      ) as Record<string, unknown>;

      expect(migrated.autoStashOnCheckout, 'v2 rule').to.equal(true);
      expect(migrated.wordWrap, 'v3 rule').to.equal(false);
      expect(migrated.graphColorSchemeAuto, 'v4 rule').to.equal(true);
      expect(migrated.showAvatars, 'v5 rule').to.equal(true);
      expect(migrated.diffIgnoreWhitespace, 'v6 rule').to.equal('none');
      expect(migrated, 'v7 rule').to.not.have.property('defaultRemoteName');
      expect(migrated.language, 'v8 rule').to.equal('en');
      expect(migrated.theme, 'a real user choice survives all of it').to.equal('light');
    });

    /**
     * The same upgrade path entered at EVERY version we have ever shipped.
     *
     * A rule must fire exactly once — for the installs that predate it — and
     * never again: the blob a v4 install persists is a v4 blob, and re-running
     * the v2/v3/v4 rules over it would overwrite choices the user really made.
     * So every case below starts from the SAME blob, whose every value is the
     * opposite of what its rule would write, and asserts that exactly the rules
     * numbered ABOVE the entry version fired and the ones at or below it left
     * the stored values alone. The numbering is load-bearing: a rule inserted
     * out of order, or a version bump without a rule, shows up here.
     */
    describe('the full upgrade path, from every entry version', () => {
      const migrateFrom = (fromVersion: number): Record<string, unknown> =>
        migrateSettings(
          {
            autoStashOnCheckout: false,
            wordWrap: true,
            graphColorScheme: 'default',
            showWhitespace: true,
            defaultRemoteName: 'upstream',
            theme: 'light',
          } as unknown as Partial<SettingsState>,
          fromVersion
        ) as unknown as Record<string, unknown>;

      for (const from of [1, 2, 3, 4, 5, 6, 7, 8]) {
        it(`fires exactly the rules above v${from}`, () => {
          const migrated = migrateFrom(from);

          // v2: auto-stash was never read before it, so a stored `false` is
          // only a real choice from v2 onwards.
          expect(migrated.autoStashOnCheckout, 'v2').to.equal(from < 2 ? true : false);
          // v3: same story for word wrap.
          expect(migrated.wordWrap, 'v3').to.equal(from < 3 ? false : true);
          // v4: the scheme is un-pinned only for blobs that predate the flag.
          expect(migrated.graphColorSchemeAuto, 'v4').to.equal(from < 4 ? true : undefined);
          // v5: the OLD avatar default is filled in only where the key is absent
          // AND the blob predates the flip.
          expect(migrated.showAvatars, 'v5').to.equal(from < 5 ? true : undefined);
          // v6: the dead flag is dropped and the mode seeded once.
          expect(migrated.diffIgnoreWhitespace, 'v6').to.equal(from < 6 ? 'none' : undefined);
          expect(migrated.showWhitespace, 'v6').to.equal(from < 6 ? undefined : true);
          // v7: the dead remote key is dropped once.
          expect(migrated.defaultRemoteName, 'v7').to.equal(from < 7 ? undefined : 'upstream');
          // v8: the UI language is pinned to English for installs that predate
          // the key, so an upgrade never switches language on its own.
          expect(migrated.language, 'v8').to.equal(from < 8 ? 'en' : undefined);
          // Nothing in the chain touches a genuine preference.
          expect(migrated.theme, 'a real user choice survives every entry point').to.equal(
            'light'
          );
        });
      }

      it('a fresh install has no persisted blob, so it follows the OS language', () => {
        // The other half of the v8 rule: `detectSystemLocale()` is what a FIRST
        // run does. `resetToDefaults()` re-applies exactly the fresh-install
        // defaults, so it is the closest thing to a fresh install a test has.
        settingsStore.getState().resetToDefaults();

        expect(settingsStore.getState().language).to.equal(detectSystemLocale());
      });
    });

    it('a pre-v8 state keeps English instead of adopting the OS language', () => {
      // The upgrading user has been reading an English UI for as long as the
      // app has existed. Filling the new key from the system locale would
      // switch their whole UI to another language on first launch, unasked.
      const migrated = migrateSettings({ theme: 'light' } as Partial<SettingsState>, 7);

      expect(migrated.language).to.equal('en');
      expect(migrated.theme, 'other settings survive').to.equal('light');
    });

    it('a persisted language is a real choice and is never overwritten', () => {
      const migrated = migrateSettings(
        { language: 'fr' } as unknown as Partial<SettingsState>,
        1
      );

      expect(migrated.language).to.equal('fr');
    });

    it('a v8 state is left to the store default', () => {
      // From v8 the key is always written, so an absent one is not a
      // pre-existing choice and must fall through to the default.
      const migrated = migrateSettings({ theme: 'light' } as Partial<SettingsState>, 8);

      expect(migrated.language, 'left to the store default').to.equal(undefined);
    });

    it('a v1 install that pinned a non-default scheme keeps it through the chain', () => {
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate(
        { graphColorScheme: 'high-contrast', defaultRemoteName: 'upstream' },
        1
      ) as Record<string, unknown>;

      expect(migrated.graphColorScheme).to.equal('high-contrast');
      expect(migrated.graphColorSchemeAuto, 'a deliberate scheme stays pinned').to.equal(false);
      expect(migrated).to.not.have.property('defaultRemoteName');
    });

    it('leaves a v3 wordWrap alone', () => {
      const persist = (
        settingsStore as unknown as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist;
      const migrate = persist.getOptions().migrate!;

      const migrated = migrate({ wordWrap: true }, 3) as { wordWrap: boolean };

      expect(migrated.wordWrap, 'a v3 value is a real user choice').to.equal(true);
    });
  });

  describe('legacy diff word-wrap key', () => {
    const LEGACY_KEY = 'gitnado-diff-word-wrap';

    const rehydrate = (): void => {
      (settingsStore as unknown as { persist: { rehydrate: () => void } }).persist.rehydrate();
    };

    afterEach(() => {
      localStorage.removeItem(LEGACY_KEY);
    });

    it('adopts the diff view word-wrap preference and removes the old key', () => {
      localStorage.setItem(LEGACY_KEY, 'true');

      rehydrate();

      expect(settingsStore.getState().wordWrap, 'the only real choice is carried over').to.be.true;
      expect(localStorage.getItem(LEGACY_KEY), 'the old key is adopted once, then dropped').to.be
        .null;
    });

    it('treats any non-"true" stored value as off and still drops the key', () => {
      localStorage.setItem(LEGACY_KEY, 'yes');

      rehydrate();

      expect(settingsStore.getState().wordWrap).to.be.false;
      expect(localStorage.getItem(LEGACY_KEY)).to.be.null;
    });

    it('leaves the setting alone when there is no old key to adopt', () => {
      localStorage.removeItem(LEGACY_KEY);
      settingsStore.getState().setWordWrap(true);

      rehydrate();

      expect(settingsStore.getState().wordWrap, 'a real setting is not clobbered').to.be.true;
    });
  });

  describe('system high contrast (forced colors)', () => {
    afterEach(() => {
      // Leave the store the way the real environment reports it.
      settingsStore.getState().resetToDefaults();
      settingsStore.getState().applySystemContrast(false);
    });

    it('auto-selects the high-contrast palette when the OS asks for it', () => {
      settingsStore.getState().applySystemContrast(true);

      expect(settingsStore.getState().graphColorScheme).to.equal('high-contrast');
      expect(settingsStore.getState().systemHighContrast).to.be.true;
      expect(settingsStore.getState().graphColorSchemeAuto, 'still automatic').to.be.true;
      expect(document.documentElement.getAttribute('data-graph-scheme')).to.equal('high-contrast');
    });

    it('reverts to the default palette when the OS setting turns off again', () => {
      settingsStore.getState().applySystemContrast(true);
      settingsStore.getState().applySystemContrast(false);

      expect(settingsStore.getState().graphColorScheme).to.equal('default');
      expect(settingsStore.getState().systemHighContrast).to.be.false;
      expect(document.documentElement.getAttribute('data-graph-scheme')).to.equal('default');
    });

    it('a scheme picked by the user pins it and survives a contrast change', () => {
      settingsStore.getState().setGraphColorScheme('vibrant');
      expect(settingsStore.getState().graphColorSchemeAuto, 'picking pins the choice').to.be.false;

      settingsStore.getState().applySystemContrast(true);

      expect(settingsStore.getState().graphColorScheme, 'the choice wins').to.equal('vibrant');
      expect(settingsStore.getState().systemHighContrast, 'but the OS state is tracked').to.be.true;

      settingsStore.getState().applySystemContrast(false);
      expect(settingsStore.getState().graphColorScheme).to.equal('vibrant');
    });

    it('keeps following the OS again after a reset to defaults', () => {
      settingsStore.getState().setGraphColorScheme('pastel');
      settingsStore.getState().applySystemContrast(true);
      expect(settingsStore.getState().graphColorScheme).to.equal('pastel');

      settingsStore.getState().resetToDefaults();

      expect(settingsStore.getState().graphColorSchemeAuto).to.be.true;
      expect(settingsStore.getState().graphColorScheme, 'reset re-reads the OS').to.equal(
        'high-contrast'
      );
    });

    describe('watchSystemContrast', () => {
      interface FakeQuery {
        media: string;
        matches: boolean;
        listeners: Set<() => void>;
        addEventListener: (type: string, fn: () => void) => void;
        removeEventListener: (type: string, fn: () => void) => void;
      }

      let originalMatchMedia: typeof window.matchMedia;
      let queries: Map<string, FakeQuery>;

      const makeQuery = (media: string): FakeQuery => ({
        media,
        matches: false,
        listeners: new Set<() => void>(),
        addEventListener(_type, fn) {
          this.listeners.add(fn);
        },
        removeEventListener(_type, fn) {
          this.listeners.delete(fn);
        },
      });

      const fire = (media: string, matches: boolean): void => {
        const q = queries.get(media);
        if (!q) throw new Error(`no query registered for ${media}`);
        q.matches = matches;
        q.listeners.forEach((fn) => fn());
      };

      beforeEach(() => {
        originalMatchMedia = window.matchMedia;
        queries = new Map();
        window.matchMedia = ((media: string) => {
          let q = queries.get(media);
          if (!q) {
            q = makeQuery(media);
            queries.set(media, q);
          }
          return q as unknown as MediaQueryList;
        }) as typeof window.matchMedia;
      });

      afterEach(() => {
        window.matchMedia = originalMatchMedia;
      });

      it('watches both forced-colors and prefers-contrast', () => {
        const stop = watchSystemContrast();

        expect([...queries.keys()]).to.have.members([
          '(forced-colors: active)',
          '(prefers-contrast: more)',
        ]);

        stop();
      });

      it('applies the palette on either query matching, and on later changes', () => {
        const stop = watchSystemContrast();
        expect(settingsStore.getState().graphColorScheme).to.equal('default');

        fire('(prefers-contrast: more)', true);
        expect(settingsStore.getState().graphColorScheme).to.equal('high-contrast');

        fire('(prefers-contrast: more)', false);
        expect(settingsStore.getState().graphColorScheme).to.equal('default');

        fire('(forced-colors: active)', true);
        expect(settingsStore.getState().graphColorScheme).to.equal('high-contrast');

        stop();
      });

      it('applies immediately when the OS is already in high contrast at startup', () => {
        queries.set('(forced-colors: active)', {
          ...makeQuery('(forced-colors: active)'),
          matches: true,
        });

        const stop = watchSystemContrast();

        expect(settingsStore.getState().graphColorScheme).to.equal('high-contrast');
        stop();
      });

      it('stops listening once disposed', () => {
        const stop = watchSystemContrast();
        stop();

        fire('(forced-colors: active)', true);

        expect(settingsStore.getState().graphColorScheme).to.equal('default');
      });
    });
  });

  describe('migrateSettings', () => {
    it('leaves existing users who never picked a scheme on automatic', () => {
      const migrated = migrateSettings(
        { graphColorScheme: 'default', theme: 'light' } as Partial<SettingsState>,
        3
      );

      expect(migrated.graphColorSchemeAuto).to.be.true;
      expect(migrated.theme, 'unrelated settings are untouched').to.equal('light');
    });

    it('treats a stored non-default scheme as a deliberate choice and pins it', () => {
      const migrated = migrateSettings({ graphColorScheme: 'pastel' } as Partial<SettingsState>, 3);

      expect(migrated.graphColorSchemeAuto).to.be.false;
      expect(migrated.graphColorScheme).to.equal('pastel');
    });

    it('treats a state with no stored scheme at all as automatic', () => {
      const migrated = migrateSettings({}, 1);

      expect(migrated.graphColorSchemeAuto).to.be.true;
    });

    it('does not re-run the colour-scheme rule for state already at v4', () => {
      const migrated = migrateSettings(
        { graphColorScheme: 'default', graphColorSchemeAuto: false } as Partial<SettingsState>,
        4
      );

      expect(migrated.graphColorSchemeAuto, 'a pinned default stays pinned').to.be.false;
    });

    // The rules stack: a user who has not opened the app for several releases
    // arrives with an old version number and must pick up EVERY step, not just
    // the newest one.
    it('applies every rule for a user upgrading all the way from v1', () => {
      const migrated = migrateSettings(
        {
          autoStashOnCheckout: false,
          wordWrap: true,
          graphColorScheme: 'default',
          theme: 'light',
        } as Partial<SettingsState>,
        1
      );

      expect(migrated.autoStashOnCheckout, 'v2 rule').to.be.true;
      expect(migrated.wordWrap, 'v3 rule').to.be.false;
      expect(migrated.graphColorSchemeAuto, 'v4 rule').to.be.true;
      expect(migrated.showAvatars, 'v5 rule').to.equal(true);
      expect(migrated.theme, 'unrelated settings are untouched').to.equal('light');
    });

    it('applies only the v5 rule to a state already at v4', () => {
      const migrated = migrateSettings(
        {
          autoStashOnCheckout: false,
          wordWrap: true,
          graphColorScheme: 'pastel',
          graphColorSchemeAuto: false,
        } as Partial<SettingsState>,
        4
      );

      expect(migrated.autoStashOnCheckout, 'a post-v2 choice stands').to.be.false;
      expect(migrated.wordWrap, 'a post-v3 choice stands').to.be.true;
      expect(migrated.graphColorSchemeAuto, 'the v4 pin stands').to.be.false;
      expect(migrated.showAvatars, 'v5 fills in the old default').to.equal(true);
    });

    it('never overwrites a showAvatars the user actually chose', () => {
      expect(migrateSettings({ showAvatars: false } as Partial<SettingsState>, 1).showAvatars).to.be
        .false;
      expect(migrateSettings({ showAvatars: true } as Partial<SettingsState>, 1).showAvatars).to.be
        .true;
    });

    it('does not re-run the avatar rule for state already at the current version', () => {
      expect(migrateSettings({}, 5).showAvatars, 'left to the store default').to.equal(undefined);
    });

    it('replaces the dead showWhitespace flag with the whitespace mode', () => {
      const migrated = migrateSettings({ showWhitespace: true } as Partial<SettingsState>, 4);

      expect(migrated.diffIgnoreWhitespace).to.equal('none');
      expect(
        (migrated as unknown as Record<string, unknown>).showWhitespace,
        'the dead flag is dropped, not carried over'
      ).to.equal(undefined);
    });

    it('leaves an already-current whitespace mode alone', () => {
      const migrated = migrateSettings(
        { diffIgnoreWhitespace: 'all' } as Partial<SettingsState>,
        6
      );

      expect(migrated.diffIgnoreWhitespace).to.equal('all');
    });

    it('clamps a stored context-line count into range', () => {
      expect(migrateSettings({ diffContextLines: 999 } as Partial<SettingsState>, 4).diffContextLines).to.equal(
        MAX_DIFF_CONTEXT_LINES
      );
      expect(migrateSettings({ diffContextLines: -8 } as Partial<SettingsState>, 4).diffContextLines).to.equal(
        MIN_DIFF_CONTEXT_LINES
      );
      expect(
        migrateSettings({ diffContextLines: 7 } as Partial<SettingsState>, 4).diffContextLines,
        'an in-range value is untouched'
      ).to.equal(7);
    });

    it('applies every step for a v3 install upgrading to the current version', () => {
      // One existing user's whole persisted blob, as v3 wrote it: a deliberate
      // non-default palette, the dead whitespace flag, and an out-of-range
      // context count. Both the colour-scheme rule and the whitespace
      // replacement must land in the same upgrade.
      const migrated = migrateSettings(
        {
          graphColorScheme: 'vibrant',
          showWhitespace: true,
          diffContextLines: 99,
          autoStashOnCheckout: false,
          wordWrap: true,
          theme: 'light',
        } as Partial<SettingsState>,
        3
      );

      expect(migrated.graphColorSchemeAuto, 'v4: a chosen palette stays pinned').to.be.false;
      expect(migrated.graphColorScheme).to.equal('vibrant');
      expect(migrated.diffIgnoreWhitespace, 'v6: the whitespace mode is seeded').to.equal('none');
      expect((migrated as unknown as Record<string, unknown>).showWhitespace).to.equal(undefined);
      expect(migrated.diffContextLines).to.equal(MAX_DIFF_CONTEXT_LINES);
      expect(migrated.wordWrap, 'already at v3, so the v3 rule does not re-run').to.be.true;
      expect(migrated.theme, 'unrelated settings survive').to.equal('light');
    });

    it('applies every step for a pre-v2 install upgrading to the current version', () => {
      const migrated = migrateSettings(
        { showWhitespace: false, wordWrap: true } as Partial<SettingsState>,
        1
      );

      expect(migrated.autoStashOnCheckout, 'v2').to.be.true;
      expect(migrated.wordWrap, 'v3 drops the never-read flag').to.be.false;
      expect(migrated.graphColorSchemeAuto, 'v4').to.be.true;
      expect(migrated.diffIgnoreWhitespace, 'v6').to.equal('none');
    });

    // Three independent changes each wanted to be "the next version". Giving
    // them one shared number would have meant a user migrated by the first
    // never running the other two — silently, and forever, because the stored
    // version would already be current. Each rule therefore owns its own step,
    // and these two tests are what pins that down.
    it('runs every rule from v5, v6 and v7 for a v3 install', () => {
      const migrated = migrateSettings(
        {
          graphColorScheme: 'default',
          showWhitespace: true,
          defaultRemoteName: 'upstream',
          theme: 'light',
        } as Partial<SettingsState>,
        3
      );

      expect(migrated.graphColorSchemeAuto, 'v4: graphColorSchemeAuto').to.be.true;
      expect(migrated.showAvatars, 'v5: the old avatar default is filled in').to.equal(true);
      expect(migrated.diffIgnoreWhitespace, 'v6: diffIgnoreWhitespace is seeded').to.equal('none');
      expect(
        (migrated as unknown as Record<string, unknown>).showWhitespace,
        'v6: the dead whitespace flag is dropped'
      ).to.equal(undefined);
      expect(
        migrated as unknown as Record<string, unknown>,
        'v7: the dead remote key is dropped'
      ).to.not.have.property('defaultRemoteName');
      expect(migrated.theme, 'unrelated settings survive the whole chain').to.equal('light');
    });

    it('a state already at v5 still receives the v6 and v7 rules', () => {
      // The collision case: had all three changes shared `version: 5`, this
      // state would be considered current and would keep both dead keys.
      const migrated = migrateSettings(
        {
          showAvatars: false,
          showWhitespace: true,
          defaultRemoteName: 'upstream',
          theme: 'light',
        } as Partial<SettingsState>,
        5
      );

      expect(migrated.showAvatars, 'the v5 rule does not re-run over a real choice').to.equal(
        false
      );
      expect(migrated.diffIgnoreWhitespace, 'v6 still runs').to.equal('none');
      expect(
        (migrated as unknown as Record<string, unknown>).showWhitespace,
        'v6 still runs'
      ).to.equal(undefined);
      expect(
        migrated as unknown as Record<string, unknown>,
        'v7 still runs'
      ).to.not.have.property('defaultRemoteName');
      expect(migrated.theme).to.equal('light');
    });

    it('a state already at v7 is left alone', () => {
      const migrated = migrateSettings(
        { showAvatars: false, diffIgnoreWhitespace: 'all', theme: 'light' } as Partial<
          SettingsState
        >,
        7
      );

      expect(migrated.showAvatars).to.equal(false);
      expect(migrated.diffIgnoreWhitespace, 'a chosen mode is not reset').to.equal('all');
      expect(migrated.theme).to.equal('light');
    });
  });
});
