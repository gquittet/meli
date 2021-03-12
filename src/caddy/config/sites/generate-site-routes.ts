import { Header } from '../../../entities/sites/header';
import { AcmeSslConfiguration, Site, SiteDomain } from '../../../entities/sites/site';
import { unique } from '../../../utils/arrays-utils';
import { getBranchCaddyConfigId } from '../ids';
import { getAuthHandler } from './get-auth-handler';
import { getRedirectRoute } from './get-redirect-route';
import { getBranchDirInCaddy } from '../../../entities/sites/get-site-dir';
import { Branch } from '../../../entities/sites/branch';
import { getBranch404ErrorRoute } from './get-branch-404-error-route';
import { getSiteMainDomain } from '../../../entities/sites/get-site-main-domain';
import Encode = Caddy.Http.Route.Handlers.Encode;
import FileServer = Caddy.Http.Route.Handlers.FileServer;
import Headers = Caddy.Http.Route.Handlers.Headers;

export function generateSiteRoutes(site: Site): Caddy.Http.Route[] {
  return !site.branches ? [] : site.branches.map(branch => generateBranchRoute(site, branch));
}

export function generateBranchRoute(site: Site, branch: Branch): Caddy.Http.Route {
  const domains: SiteDomain[] = [
    // custom domains
    ...(site.domains || []),
    // domain under meli's hostname
    <SiteDomain>{
      name: getSiteMainDomain(site),
      exposeBranches: true,
      sslConfiguration: {
        type: 'acme',
      } as AcmeSslConfiguration,
    },
  ].filter(unique);

  const hosts = domains
    .filter(domain => !!domain.exposeBranches)
    .map(domain => `${branch.slug}.${domain.name}`);
  if (branch._id === site.mainBranch) {
    hosts.push(...domains.map(({ name }) => name));
  }

  return {
    '@id': getBranchCaddyConfigId(site, branch),
    group: site._id,
    match: [{
      host: hosts,
    }],
    handle: [{
      handler: 'subroute',
      /*
       * Per Caddy's docs (https://caddyserver.com/docs/modules/http.handlers.subroute),
       * we could handle errors here for this site, but when I try it, it breaks
       * password protection. I'm assuming there's a clash between 401 handling, the
       * auth route and the error handler defined in errors.
       */
      routes: [
        ...(branch.password || site.password ? [{
          handle: [
            getAuthHandler(branch.password || site.password),
          ],
        }] : []),
        ...(!branch.redirects ? [] : branch.redirects.map(redirect => (
          getRedirectRoute(site, branch, redirect)
        ))),
        getPrimaryRoute(site, branch),
      ],
      errors: {
        routes: [
          get401ErrorRoute(),
          getBranch404ErrorRoute(site, branch),
        ],
      },
    }],
  };
}

function get401ErrorRoute(): Caddy.Http.Route {
  return {
    match: [{
      expression: '{http.error.status_code} == 401',
    }],
    handle: [{
      handler: 'static_response',
      body: 'not authenticated',
      status_code: '{http.error.status_code}',
    }],
  };
}

// https://caddyserver.com/docs/json/apps/http/servers/routes/handle/encode/encodings/gzip/
// https://caddy.community/t/gzip-headers-when-using-encode-handler/11781
const gzipHandler: Encode = {
  handler: 'encode',
  encodings: {
    gzip: {},
  },
};

function getPrimaryRoute(site: Site, branch: Branch): Caddy.Http.Route {
  const branchDirInCaddy = getBranchDirInCaddy(site._id, branch._id);

  const fileHandler: FileServer = {
    handler: 'file_server',
    root: branchDirInCaddy,
  };

  // https://caddyserver.com/docs/json/apps/http/servers/routes/handle/headers/
  const siteAndBranchHeaders: Header[] = [
    ...(site.headers || []),
    ...(branch.headers || []),
  ];
  const headersHandler: Headers = {
    handler: 'headers',
    response: {
      set: {
        'Cache-Control': ['public', 'max-age=0', 'must-revalidate'],
        ...siteAndBranchHeaders.reduce((prev, { name, value }) => {
          // TODO should this be split by comma ?
          prev[name] = [value];
          return prev;
        }, {}),
      },
    },
  };

  if (site.spa) {
    return {
      match: [{
        file: {
          root: branchDirInCaddy,
          try_files: [
            '{http.request.uri.path}',
            '/index.html',
          ],
        },
      }],
      handle: [
        {
          handler: 'rewrite',
          uri: '{http.matchers.file.relative}',
        },
        headersHandler,
        gzipHandler,
        fileHandler,
      ],
    };
  }

  return {
    handle: [
      headersHandler,
      gzipHandler,
      fileHandler,
    ],
  };
}
