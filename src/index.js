import glob from 'glob';
import gulp from 'gulp';
import gutil from 'gulp-util';
import plumber from 'gulp-plumber';
import tap from 'gulp-tap';
import gulpFilter from 'gulp-filter';
import fs from 'fs';
import path from 'path';
import del from 'del';
import yargs from 'yargs';
import yaml from 'js-yaml';
import { load, validate } from './config/index.js';

// entry
export default async () => {
  const startTime = new Date();
  gutil.log(gutil.colors.yellow('Loading gassetic.yml'));

  try {
    const env = yargs.argv.env || 'dev';
    const command = yargs.argv._[0];

    const config = load('gassetic.yml');
    validate(config);

    const steps = getBuildSteps(config);
    const modules = loadModules(config.requires);


    // clear
    await Promise.all(
      steps.reduce((promises, deps) =>
        promises.concat(
          deps.reduce((currentMimetypePromises, dep) =>
            currentMimetypePromises.concat(
              Object.keys(config.mimetypes[dep].files || {})
                .map(destinationFolder =>
                  path.join(config.mimetypes[dep][env].outputFolder, destinationFolder))
            )
          , [])
        ), [])
        .map(destinationFolder => del(destinationFolder))
    );

    if (command === 'clear') {
      gutil.log(gutil.colors.green('Cleared.'));
      return;
    }

    if (steps.length == 0)
      return;

    let hasErrors = false;

    const allFiles = (await Promise.all(steps.map(async deps => {
      const replacements = [];

      for (const dep of deps) {
        try {
          const tasks = getTasks(modules, config.mimetypes[dep], env);
          const startTaskTime = new Date();

          gutil.log(`${gutil.colors.magenta('▸')} compiling ${gutil.colors.cyan(dep)} with ${gutil.colors.gray(tasks.map(t => t.name).join(', '))}`);
          const files = await runTasks(config.mimetypes[dep].files, tasks, config.mimetypes[dep][env]);
          gutil.log(`${gutil.colors.green('✓')} ${gutil.colors.green(dep)} finished ${gutil.colors.gray(`in ${Math.round((new Date() - startTaskTime) / 10) / 100}s`)}`);
          replacements.push({
            mimetype: dep,
            htmlTag: config.mimetypes[dep][env].htmlTag || getDefaultHtmlTag(Object.keys(files)[0] || ''),
            files
          });

          if (env === 'dev' && command !== 'build') {
            Object.entries(config.mimetypes[dep].files).map(([key, files]) => {
              gutil.log(`${gutil.colors.white('▸ watching')} ${gutil.colors.gray(key)}`);
              gulp.watch(config.mimetypes[dep].watch || files, { maxListeners: Infinity }, async () => {
                gutil.log(`${gutil.colors.yellow('▸ compiling')} ${gutil.colors.cyan(dep)}`);
                await runTasks({ [key]: files }, tasks, config.mimetypes[dep][env]);
                gutil.log(`${gutil.colors.green('✓')} finished ${gutil.colors.cyan(dep)}`);
              });
            });
          }
        } catch (e) {
          hasErrors = true;
          gutil.log(gutil.colors.red(e));
        }
      }
      return replacements;
    })))
      .reduce((a, b) => a.concat(b))
      .filter(a => a.htmlTag);

    gutil.log(gutil.colors.blue('Updating templates 📝'));
    await replaceInTemplates(config.replacementPaths, allFiles, env);
    gutil.log(gutil.colors.blue(`Creating gassetic.dump.${env}.yml`));
    await createResultsFile(config.resultsFolder, allFiles, env);
    gutil.log(gutil.colors.green(`Build finished in ${Math.round((new Date() - startTime) / 10) / 100}s 👍`));
    if (hasErrors) {
      gutil.log(gutil.colors.red('But hey, there were errors'));
      process.exit(1);
    } else if (env !== 'dev' || command === 'build') {
      process.exit(0);
    }
  } catch (e) {
    gutil.log(gutil.colors.red(e, e.stack));
    process.exit(1);
  }
};

// steps
export const getBuildSteps = config =>
  config.default.map(mimetype => getBuildStepDependency(config, mimetype));

const getBuildStepDependency = (config, mimetype) =>
  (config.mimetypes[mimetype].deps || [])
    .reduce((final, dep) => getBuildStepDependency(config, dep).concat(final), [mimetype]);

// modules
const loadModules = requires => {
  module.paths.unshift(path.join(process.cwd(), 'node_modules'));
  module.paths.unshift(process.cwd());
  return Object.entries(requires)
    .reduce((registry, [moduleKey, module]) => ({
      ...registry,
      [moduleKey]: require(module.startsWith('./') && path.join(process.cwd(), module) || module)
    }), {});
};

// tasks
export const getTasks = (modules, mimetype, environment) =>
  mimetype[environment].tasks.reduce((tasks, task) => {
    if (task.callback) {
      task.callback = modules[task.callback];
    }
    const taskDescription = { ...task, fn: getModuleFunction(modules, task.name) };
    if (task.filter) {
      const filter = gulpFilter(task.filter, { restore: true });
      return [...tasks, { ...taskDescription, filter }];
    }
    return [...tasks, taskDescription];
  }, []);

const getModuleFunction = (modules, taskName) =>
  taskName.split('.').reduce((scope, taskPart) => scope[taskPart], modules);

export const runTasks = async (files, tasks, { outputFolder, webPath }) =>
  (await Promise.all(Object.keys(files).map(destFilename => new Promise((resolve, reject) => {
    try {
      const filesCreated = [];
      [{ fn: plumber, callback: e => reject(e) }].concat(tasks).reduce(
        (pipe, nextTask) => {
          if (nextTask.filter) {
            pipe = pipe.pipe(nextTask.filter);
          }
          pipe = pipe.pipe(nextTask.callback ?
            nextTask.fn(nextTask.callback)
            : replaceArguments(nextTask, { filename: destFilename })()
          );
          if (nextTask.filter) {
            pipe = pipe.pipe(nextTask.filter.restore);
          }
          return pipe;
        },
        gulp.src(files[destFilename])
      )
      .pipe(gulp.dest(path.join(outputFolder, destFilename)))
      .pipe(tap(file => {
        if (yargs.argv.print)
          gutil.log(gutil.colors.white('▸ ') + gutil.colors.gray(`compiled ${file.path}`));

        if (!webPath) return;
        const filepath = file.path.substring(process.cwd().length).replace(/\\/g, '/').replace(outputFolder, '');
        const fileWebPath = path.join(webPath, filepath).replace(/\\/g, '/');
        filesCreated.push(fileWebPath);
      }))
      .on('end', () => resolve({ [destFilename]: filesCreated }));
    } catch (e) {
      reject(e);
    }
  })))).reduce((all, next) => ({ ...all, ...next }), {});

const replaceArguments = ({ fn, args }, { filename }) => () => {
  const replaced = JSON.parse(JSON.stringify(args || []).replace('%filename%', filename));
  return fn.apply(fn, Array.isArray(replaced) && replaced || [replaced]);
};

// replacement paths
export const replaceInTemplates = (replacementPaths, files, environment) =>
  new Promise(async (resolve, reject) => {
    try {
      const templates = (await Promise.all(replacementPaths.map(globPromised))).reduce((a, b) => a.concat(b));
      templates.forEach(template => {
        const content = files.reduce((newContent, mimetype) =>
          Object.entries(mimetype.files).reduce((newContent, [destFilename, files]) => {
            const scripts = files.map(path => (mimetype.htmlTag || getDefaultHtmlTag(path)).replace('%path%', path));
            return newContent.replace(
              new RegExp(`([ \t]*)<!-- ${environment}:${destFilename} -->([\\s\\S]*?)<!-- endbuild -->`, 'ig'),
              `$1<!-- ${environment}:${destFilename} -->\n$1${scripts.map(script => '  ' + script).join('\n$1')}\n$1<!-- endbuild -->`
            );
          }, newContent),
          fs.readFileSync(template, 'utf-8'));
        fs.writeFileSync(template, content);
      });
      resolve();
    } catch (e) {
      reject(e);
    }
  });

const getDefaultHtmlTag = filename => ({
  '.js': '<script src="%path%"></script>',
  '.css': '<link rel="stylesheet" type="text/css" href="%path%">'
})[path.extname(filename)] || '<!-- htmlTag not provided -->';

const createResultsFile = (resultsFolder = process.cwd(), files, environment) =>
  new Promise(resolve => {
    const dump = yaml.safeDump(files, { lineWidth: Infinity });
    fs.writeFileSync(path.join(resultsFolder, `gassetic.dump.${environment}.yml`), dump, 'utf-8');
    resolve();
  });

const globPromised = pattern =>
  new Promise(resolve => glob(pattern, {}, (err, matches) => resolve(matches)));
