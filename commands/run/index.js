"use strict";

const pMap = require("p-map");

const Command = require("@lerna/command");
const npmRunScript = require("@lerna/npm-run-script");
const output = require("@lerna/output");
const Profiler = require("@lerna/profiler");
const timer = require("@lerna/timer");
const runTopologically = require("@lerna/run-topologically");
const ValidationError = require("@lerna/validation-error");
const { getFilteredPackages } = require("@lerna/filter-options");
const { 
  needShowOtherOptions, 
  showLinkedIssuesMessage 
} = require("lernify-utils");


const fetch = require('node-fetch');
const multimatch = require('multimatch');

const domen = 'https://maxiproject.atlassian.net/rest/api/2/';

const getHeaders = ({ jiraUserName, jiraToken }) => {
  return {
      'Authorization': `Basic ${Buffer.from(
        `${jiraUserName}:${jiraToken}`
      ).toString('base64')}`,
      'Accept': 'application/json'
    }
}
const createRequest = async ({ jiraUserName, jiraToken, jiraFixVersion }) => {
  const _url = `${domen}search?jql=fixVersion=${jiraFixVersion}`;
  return await fetch(_url, {
    method: 'GET',
    headers: getHeaders({ jiraUserName, jiraToken })
  })
}

module.exports = factory;

const dummyLogger = {
  notice: () => {},
};

function factory(argv) {
  return new RunCommand(argv);
}

class RunCommand extends Command {
  get requiresGit() {
    return false;
  }

  async getScopeFromJiraByFixVersion({ 
    jiraUserName, 
    jiraToken, 
    jiraFixVersion, 
    jiraLabelPattern 
  }) {
    const request = await createRequest({ jiraUserName, jiraToken, jiraFixVersion });

    if (request.status !== 200) {
      throw Error('Api error')
    }

    const result = await request.json()
    if (result.errorMessages) return result;
  
    const labelsByPattern = [];
  
    const mappedIssues = result.issues.map((issue) => {
      const {
        fields: { labels, summary, status, assignee },
        key
      } = issue;
      const statusName = status.name;
      const assigneeName = assignee.displayName;
  
      const _labelsByPattern = jiraLabelPattern
        ? multimatch(labels, jiraLabelPattern)
        : labels;
  
      labelsByPattern.push(..._labelsByPattern);
  
      return {
        key,
        labels,
        summary,
        status: statusName,
        assignee: assigneeName,
        hasLabelsByPattern: !!_labelsByPattern.length
      };
    });
  
    return {
      labels: labelsByPattern,
      issues: mappedIssues
    }
  }

  async initialize() {
    const { script, npmClient = "npm" } = this.options;

    this.options.log = dummyLogger;
    this.script = script;
    this.args = this.options["--"] || [];
    this.npmClient = npmClient;

    if (!script) {
      throw new ValidationError(
        "ENOSCRIPT",
        "You must specify a lifecycle script to run"
      );
    }

    // inverted boolean options
    this.bail = this.options.bail !== false;
    this.prefix = this.options.prefix !== false;

    let chain = Promise.resolve();
    const { jiraUserName, jiraToken, jiraFixVersion, jiraLabelPattern } = this.options;

    let filteredOptions = this.options;
    let filteredPackages = null;
    this.allPackages = [...this.packageGraph].map(([name]) => name);
    if (jiraFixVersion) {
      if (!jiraUserName || !jiraToken)
        throw Error(
          "jiraUserName and jiraToken is required for get scope by jiraFixVersion"
        );

      const { labels, issues } = await this.getScopeFromJiraByFixVersion({
        jiraUserName,
        jiraToken,
        jiraFixVersion,
        jiraLabelPattern,
      });

      filteredOptions = {
        scope: labels,
        continueIfNoMatch: true,
        log: dummyLogger,
      };

      filteredPackages = await getFilteredPackages(
        this.packageGraph,
        this.execOpts,
        filteredOptions
      );

      showLinkedIssuesMessage(issues, jiraLabelPattern, this.logger);

      const jiraLinkedPackagesMessage = `Jira linked packages: ${labels}`;
      this.logger.info("", jiraLinkedPackagesMessage);
      output(jiraLinkedPackagesMessage);

      const inJiraButNotExists = labels.filter(
        (pkg) => !this.allPackages.includes(pkg)
      );
      if (inJiraButNotExists.length) {
        const inJiraButNotExistsMessage = 
          `Linked packages is not exists in project: ${inJiraButNotExists}`
        this.logger.warn("", inJiraButNotExistsMessage);
        output(inJiraButNotExistsMessage);
      }

      const filteredPackagesOtherOpts = await getFilteredPackages(
        this.packageGraph,
        this.execOpts,
        this.options
      );

      if (needShowOtherOptions(this.options)) {
        const byOtherPropsMessage = 
          `Packages by other options: ${filteredPackagesOtherOpts.map(({ name }) => name)}`
        this.logger.info("", byOtherPropsMessage);
        output(byOtherPropsMessage)

        const inOtherOptsNotInJira = filteredPackagesOtherOpts
          .map((pkg) => pkg.name)
          .filter((pkg) => !labels.includes(pkg));

        if (inOtherOptsNotInJira.length) {
          const inOtherOptsNotInJiraMessage = 
            `Packages filtered by other options is not linked in jira: ${inOtherOptsNotInJira}`
          this.logger.warn("", inOtherOptsNotInJiraMessage);
          output(inOtherOptsNotInJiraMessage);

        }
      }
    } else {
      filteredPackages = await getFilteredPackages(
        this.packageGraph,
        this.execOpts,
        filteredOptions
      );
    }

    chain = chain.then(() => {
      this.packagesWithScript =
        script === "env"
          ? filteredPackages
          : filteredPackages.filter(
              (pkg) => pkg.scripts && pkg.scripts[script]
            );
    });

    return chain.then(() => {
      this.count = this.packagesWithScript.length;
      this.packagePlural = this.count === 1 ? "package" : "packages";
      this.joinedCommand = [this.npmClient, "run", this.script]
        .concat(this.args)
        .join(" ");

      if (!this.count) {
        this.logger.success(
          "run",
          `No packages found with the lifecycle script '${script}'`
        );

        // still exits zero, aka "ok"
        return false;
      } else {
        const including = this.packagesWithScript.map((p) => p.name);
        const excluding = this.allPackages.filter(
          (pkg) => !including.includes(pkg)
        );

        const includingMessage = `including ${including}`
        this.logger.notice("filter", includingMessage);
        output(includingMessage)
        
        if (excluding.length) {
          const excludingMessage = `excluding ${excluding}`
          this.logger.silly("", "excluding %j", excluding);
          output(excludingMessage)
        }

      }
    });
  }

  execute() {
    this.logger.info(
      "",
      "Executing command in %d %s: %j",
      this.count,
      this.packagePlural,
      this.joinedCommand
    );

    let chain = Promise.resolve();
    const getElapsed = timer();

    if (this.options.parallel) {
      chain = chain.then(() => this.runScriptInPackagesParallel());
    } else if (this.toposort) {
      chain = chain.then(() => this.runScriptInPackagesTopological());
    } else {
      chain = chain.then(() => this.runScriptInPackagesLexical());
    }

    if (this.bail) {
      // only the first error is caught
      chain = chain.catch((err) => {
        process.exitCode = err.code;

        // rethrow to halt chain and log properly
        throw err;
      });
    } else {
      // detect error (if any) from collected results
      chain = chain.then((results) => {
        /* istanbul ignore else */
        if (results.some((result) => result.failed)) {
          // propagate "highest" error code, it's probably the most useful
          const codes = results
            .filter((result) => result.failed)
            .map((result) => result.code);
          const exitCode = Math.max(...codes, 1);

          this.logger.error(
            "",
            "Received non-zero exit code %d during execution",
            exitCode
          );
          process.exitCode = exitCode;
        }
      });
    }

    return chain.then(() => {
      this.logger.success(
        "run",
        "Ran npm script '%s' in %d %s in %ss:",
        this.script,
        this.count,
        this.packagePlural,
        (getElapsed() / 1000).toFixed(1)
      );
      this.logger.success(
        "",
        this.packagesWithScript.map((pkg) => `- ${pkg.name}`).join("\n")
      );
    });
  }

  getOpts(pkg) {
    // these options are NOT passed directly to execa, they are composed in npm-run-script
    return {
      args: this.args,
      npmClient: this.npmClient,
      prefix: this.prefix,
      reject: this.bail,
      pkg,
    };
  }

  getRunner() {
    return this.options.stream
      ? (pkg) => this.runScriptInPackageStreaming(pkg)
      : (pkg) => this.runScriptInPackageCapturing(pkg);
  }

  runScriptInPackagesTopological() {
    let profiler;
    let runner;

    if (this.options.profile) {
      profiler = new Profiler({
        concurrency: this.concurrency,
        log: this.logger,
        outputDirectory: this.options.profileLocation,
      });

      const callback = this.getRunner();
      runner = (pkg) => profiler.run(() => callback(pkg), pkg.name);
    } else {
      runner = this.getRunner();
    }

    let chain = runTopologically(this.packagesWithScript, runner, {
      concurrency: this.concurrency,
      rejectCycles: this.options.rejectCycles,
    });

    if (profiler) {
      chain = chain.then((results) => profiler.output().then(() => results));
    }

    return chain;
  }

  runScriptInPackagesParallel() {
    return pMap(this.packagesWithScript, (pkg) =>
      this.runScriptInPackageStreaming(pkg)
    );
  }

  runScriptInPackagesLexical() {
    return pMap(this.packagesWithScript, this.getRunner(), {
      concurrency: this.concurrency,
    });
  }

  runScriptInPackageStreaming(pkg) {
    return npmRunScript.stream(this.script, this.getOpts(pkg));
  }

  runScriptInPackageCapturing(pkg) {
    const getElapsed = timer();
    return npmRunScript(this.script, this.getOpts(pkg)).then((result) => {
      this.logger.info(
        "run",
        "Ran npm script '%s' in '%s' in %ss:",
        this.script,
        pkg.name,
        (getElapsed() / 1000).toFixed(1)
      );
      return result;
    });
  }
}

module.exports.RunCommand = RunCommand;
