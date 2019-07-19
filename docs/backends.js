/*
Build type:
{
   repository: name,
   branch: 'master',
   started: new Date(),
   state: 'success',
   commit: {
      created: new Date(),
      author: 'Tester',
      hash: 'shahash'
   }
}
*/

function buildBackend(settings, callback) {
  const backend = circleBackend;
  if (settings.mode === 'travis') {
    backend = travisBackend;
  } else if (settings.mode === 'jenkins') {
    backend = jenkinsBackend;
  }
  const branchFilter = function(build) {
    return settings.branch ? build.branch.match(settings.branch) : true;
  };
  const repositoryFilter = function(build) {
    return settings.repositories
      ? settings.repositories.split(',').includes(build.repository)
      : true;
  };

  return function() {
    backend(settings, function(err, data) {
      if (err) {
        return callback(err);
      }
      let builds = data.filter(repositoryFilter).filter(branchFilter);
      builds = _.uniqBy(builds, function(b) {
        return b.repository + b.branch;
      });
      builds = builds.sort(function(a, b) {
        return a.started.getTime() - b.started.getTime();
      });
      callback(undefined, builds);
    });
  };
}

function backendOptions() {
  return {
    circle: {
      name: 'Circle CI',
      url: 'https://circleci.com/api/v1/projects',
      token: undefined,
    },
    travis: {
      name: 'Travis CI',
      url: 'https://api.travis-ci.com/repos',
      token: undefined,
    },
    jenkins: {
      name: 'Jenkins CI',
      url: undefined,
      token: undefined,
    },
  };
}

function httpRequest(url, handler, arguments) {
  const request = new XMLHttpRequest();
  const headers = arguments[0] || {};
  request.open('GET', url, true);
  Object.keys(headers).forEach(function(headerName) {
    request.setRequestHeader(headerName, headers[headerName]);
  });
  request.onload = function() {
    if (request.status === 401 || request.status === 403) {
      handler('Invalid API token (' + request.status + ' ' + request.responseText + ')');
    } else if (request.status >= 200 && request.status < 400) {
      try {
        const data = JSON.parse(request.responseText);
        handler(undefined, data);
      } catch (exc) {
        console.log('Error fetching URL', url, request.responseText);
        handler(exc);
      }
    } else {
      handler('Error getting URL ' + url + ':' + request.status);
    }
  };
  request.send();
}

const travisBackend = function(settings, resultCallback) {
  const travisRequest = function(url, cb) {
    const handler = function(err, data) {
      if (err) {
        resultCallback(err);
      } else {
        cb(data);
      }
    };
    httpRequest(url, handler, {
      Accept: 'application/vnd.travis-ci.2+json',
      Authorization: 'token ' + settings.token,
    });
  };

  const translateBuild = function(reponame, commits) {
    const findCommit = function(commit) {
      return commits.find(function(c) {
        return c.id == commit;
      });
    };
    return function(b) {
      const commit = findCommit(b.commit_id);
      return {
        repository: reponame,
        branch: commit.branch,
        started: new Date(b.started_at),
        state: b.state,
        commit: {
          created: new Date(commit.committed_at),
          author: commit.author_name,
          hash: commit.sha,
        },
      };
    };
  };

  const parseBuilds = function(repos) {
    const responses = [];
    repos.forEach(function(r) {
      travisRequest(settings.url + '/' + r.name + '/builds', function(data) {
        const reponame = r.name.split('/')[1];
        const builds = data.builds.map(translateBuild(reponame, data.commits));
        responses.push(builds);
        if (responses.length === repos.length) {
          const result = responses.reduce(function(acc, item) {
            return item.length > 0 ? acc.concat(item) : acc;
          }, []);
          resultCallback(undefined, result);
        }
      });
    });
  };

  travisRequest(settings.url, function(data) {
    parseBuilds(
        data.repos.map(function(repo) {
          return {id: repo.id, name: repo.slug};
        })
    );
  });
};

const circleBackend = function(settings, resultCallback) {
  const url = settings.url + '?circle-token=' + settings.token;

  httpRequest(
      url,
      function(err, data) {
        if (err) {
          return resultCallback(err);
        }
        const builds = data.reduce(function(acc, repository) {
          return acc.concat(
              Object.keys(repository.branches).map(function(branchName) {
                const branch = repository.branches[branchName];
                const hasNeverBuilt = !branch.running_builds && !branch.recent_builds;
                if (hasNeverBuilt) {
                  console.warn('Repository', repository.reponame, 'has a branch named', branchName, 'that has never been built');
                  return;
                }
                const buildIsRunning = branch.running_builds.length != 0;
                let recent_builds = branch.recent_builds
                if (recent_builds) {
                  recent_builds = recent_builds.sort((a, b) => b.build_num - a.build_num)
                }
                var build = buildIsRunning ? branch.running_builds[0] : recent_builds[0]
                const status = buildIsRunning ? build.status : build.outcome;
                return {
                  repository: repository.reponame,
                  branch: branchName,
                  started: new Date(build.pushed_at),
                  state: status,
                  commit: {
                    created: new Date(build.pushed_at),
                    author: null,
                    hash: build.vcs_revision,
                  },
                };
              })
          );
        }, []).filter(function(build) {
          return !!build; 
        });
        resultCallback(undefined, builds);
      },
      {
        Accept: 'application/json',
      }
  );
};

const jenkinsBackend = function(settings, resultCallback) {
  const jenkinsRequest = function(url, cb) {
    const handler = function(err, data) {
      if (err) {
        resultCallback(err);
      } else {
        cb(data);
      }
    };
    const headers = {};
    if (settings.token) {
      headers.Authorization = 'Basic ' + window.btoa(settings.token);
    }
    httpRequest(url, handler, headers);
  };

  const findLastCommit = function(builds) {
    if (!builds) {
      return undefined;
    }
    const lastBuildWithCommits = builds.filter(function(b) {
      return b.changeSets && b.changeSets.length > 0;
    })[0];
    if (!lastBuildWithCommits) {
      return undefined;
    }
    const lastCommits = lastBuildWithCommits.changeSets[0].items.map(function(item) {
      return {
        created: new Date(item.timestamp),
        author: item.author.fullName,
        hash: item.commitId,
      };
    });
    return lastCommits[lastCommits.length - 1];
  };

  const findBuildReason = function(builds) {
    if (!builds) {
      return undefined;
    }
    const lastBuildWithActions = builds.filter(function(b) {
      return b.actions && b.actions.length > 0;
    })[0];
    if (!lastBuildWithActions) {
      return undefined;
    }
    const reason = lastBuildWithActions.actions
        .filter(function(a) {
          return a._class == 'hudson.model.CauseAction';
        })
        .reduce(function(acc, a) {
          return acc.concat(
              a.causes.map(function(c) {
                return c.shortDescription;
              })
          );
        }, [])
        .join(';');

    return {
      author: reason,
    };
  };

  const findResponsible = function(job) {
    if (!job.actions) {
      return undefined;
    }
    const contributorActions = job.actions.filter(function(action) {
      return action.contributor || action.contributorDisplayName;
    });
    const contributor = contributorActions[0];
    if (!contributor) {
      return undefined;
    }
    return {
      created: new Date(job.timestamp),
      author: contributor.contributorDisplayName || contributor.contributor,
    };
  };

  const url =
    settings.url +
    '/api/json?depth=4&tree=name,url,jobs[name,url,jobs[name,url,actions[contributor,contributorDisplayName,contributorEmail],buildable,builds[result,building,actions[causes[shortDescription]],changeSets[items[author[fullName],timestamp,commitId]],timestamp]]]';
  jenkinsRequest(url, function(data) {
    const builds = data.jobs.reduce(function(acc, project) {
      return acc.concat(
          project.jobs.reduce(function(acc, job) {
            if (!job.buildable) {
              return acc;
            }
            const build = job.builds[0] || {};
            let result = 'failed';
            if (build.building) {
              result = 'started';
            } else if (build.result === 'ABORTED') {
              result = 'canceled';
            } else if (build.result === 'SUCCESS') {
              result = 'success';
            }

            return acc.concat({
              repository: project.name,
              branch: job.name,
              started: new Date(build.timestamp),
              state: result,
              commit:
              findLastCommit(job.builds) || findResponsible(job) || findBuildReason(job.builds),
            });
          }, [])
      );
    }, []);
    resultCallback(undefined, builds);
  });
};
