
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
const Promise = require('bluebird');
const util = require('./util');
const UNP = require('./unp-constants');

const authLogger = util.loggers.authLogger;

function getAuthHandler(req, authManager) {
  const appData = req[`${UNP.APP_NAME}Data`];
  if (appData.service && appData.service.def) {
    const service = appData.service.def;
    const authenticationData = service.configuration.getContents(
        ['authentication.json']);
    if (authenticationData) {
      return authManager.getAuthHandlerForService(authenticationData);
    }
  } 
  return authManager.getBestAuthenticationHandler(null);
}

function getAuthPluginSession(req, pluginID, dflt) {
  if (req.session) {
    let value = req.session[pluginID];
    if (value) {
      return value;
    }
  }
  return dflt;
}

function setAuthPluginSession(req, pluginID, authPluginSession) {
  if (req.session) {
    req.session[pluginID] = authPluginSession;
    req.session['pluginID'] = pluginID; // BZ-19413, , BZLP security
  }
}

function getRelevantHandlers(authManager, body) {
  let handlers = authManager.getAllHandlers();
  if (body && body.categories) {
    const authCategories = {};
    body.categories.map(t => authCategories[t] = true);
    handlers = handlers.filter(h => 
      authCategories.hasOwnProperty(h.pluginDef.authenticationCategory));
  }
  return handlers;
}

function AuthResponse() {
  /* TODO 
   * this.doctype = ...;
   * this.version = ...;
   */
  this.categories = {};
}
AuthResponse.prototype = {
  constructor: AuthResponse,
  
  /**
   * Takes a report from an auth plugin and adds it to the structure 
   */
  addHandlerResult(handlerResult, handler) {
    const pluginID = handler.pluginID;
    const authCategory = handler.pluginDef.authenticationCategory;
    const authCategoryResult = util.getOrInit(this.categories, authCategory, {
      [this.keyField]: false,
      plugins: {}
    });
    if (handlerResult[this.keyField]) {
      authCategoryResult[this.keyField] = true;
    } 
    authCategoryResult.plugins[pluginID] = handlerResult;
  },
  
  /**
   * Checks if all auth types are successful (have at least one succesful plugin)
   * and updates the summary field on this object
   */
  updateStatus() {
    let result = false;
    for (const type of Object.keys(this.categories)) {
      const authCategoryResult = this.categories[type];
      if (!(typeof authCategoryResult) === "object") {
        continue;
      }
      if (!authCategoryResult[this.keyField]) {
        result = false;
        break;
      } else {
        result = true;
      }
    }
    this[this.keyField] = result;
  }
}

function LoginResult() {
  AuthResponse.call(this);
}
LoginResult.prototype = {
  constructor: LoginResult,
  __proto__: AuthResponse.prototype,
  
  keyField: "success"
}

function StatusResponse() {
  AuthResponse.call(this);
}
StatusResponse.prototype = {
  constructor: StatusResponse,
  __proto__: AuthResponse.prototype,
  
  keyField: "authenticated"
}

/*
 * Assumes req.session is there and behaves as it should
 */
module.exports = function(authManager) {
  return {
    
    addProxyAuthorizations(req1, req2Options) {
      const handler = getAuthHandler(req1, authManager);
      if (!handler) {
        return;
      }
      const authPluginSession = getAuthPluginSession(req1, handler.pluginID, {});
      handler.addProxyAuthorizations(req1, req2Options, authPluginSession);     
    },
    
    async getStatus(req, res) {
      const handlers = authManager.getAllHandlers();
      const result = new StatusResponse();
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = util.getOrInit(req.session, pluginID, {});
        let status;
        try {
          status = await handler.getStatus(authPluginSession, req, res); 
        } catch (error) {
          status = {
            error
          }
        }
        result.addHandlerResult(status, handler);
      }
      res.status(200).json(result);
    },

    // get status for creat accout button to define if display
    getAuthStatus(req, res) {
      const handlers = authManager.getAllHandlers();
      const result = new StatusResponse();
      for (const handler of handlers) {
        const pluginDef = handler.pluginDef;
        
        result.addHandlerResult(pluginDef, handler);
      }
      res.status(200).send(JSON.stringify({
        default: authManager.defaultType,
        types: result,
        headerless: authManager.config.headerless
      }));
    },
    
    doLogin: Promise.coroutine(function*(req, res) {
      try {
        const result = new LoginResult();
        const handlers = getRelevantHandlers(authManager, req.body);
        const authServiceHandleMaps = 
          req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps;
        for (const handler of handlers) {
          const pluginID = handler.pluginID;
          const authPluginSession = getAuthPluginSession(req, pluginID, {});
          req[`${UNP.APP_NAME}Data`].plugin.services = 
            authServiceHandleMaps[pluginID];
          const wasAuthenticate = authPluginSession.authenticated;
          const handlerResult = yield handler.authenticate(req, 
              authPluginSession, res);
          //do not modify session if not authenticated or deauthenticated
          // if (wasAuthenticate || authPluginSession.authenticated) {
            setAuthPluginSession(req, pluginID, authPluginSession);
          // }
          result.addHandlerResult(handlerResult, handler);
        }
        result.updateStatus();
        res.status(result.success? 200 : 401).json(result);
      } catch (e) {
        console.warn(e)
        res.status(500).send(e.message);
        return;
      }
    }),
    
    doLogout(req, res) {
      //FIXME XSRF
      const handlers = getRelevantHandlers(authManager, req.body);
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const userName=req.session[pluginID]? req.session[pluginID].userName ||"" :""
        const twoFactor = authManager?.config?.twoFactorAuthentication;
        const isOktaMfa = twoFactor?.enabled && twoFactor?.defaultType === 'okta';
        if(isOktaMfa){
          req.logout(err => {
            if (err) { 
              console.warn(err);
              return err; 
            }
          });
        }
        delete req.session[pluginID];
        util.clearCookies(res);
        if(userName && userName!=""){
          authLogger.info("Logout success; userName:"+userName);
        }
      }
      res.status(200).send('');
    },
    
    middleware: Promise.coroutine(function*(req, res, next) {
      try {
        if (req.url.endsWith(".websocket") && (res._header == null)) {
          //workaround for https://github.com/HenningM/express-ws/issues/64
          //copied from https://github.com/HenningM/express-ws/pull/92
          //TODO remove this once that bug is fixed
          res._header = '';
        }
        //TODO maybe we should try all handlers in a category instead?
        //Or, should we denote one handler as "special"?
        const handler = getAuthHandler(req, authManager);
        if (!handler) {
          util.clearCookies(res);
          res.status(401).send('Authentication failed: auth type missing');
          return;
        }
        const authPluginID = handler.pluginID;
        const authPluginSession = getAuthPluginSession(req, authPluginID, {});
        const result = yield handler.authorized(req, authPluginSession, res);
        //we only care if its authorized
        if (!result.authorized) {
          const errorResponse = {
            /* TODO doctype/version */
            category: handler.pluginDef.authenticationCategory,
            pluginID: authPluginID,
            result
          };
          //and if not, we can distinguish why: unauthenticated or for
          //another reason
          if (!result.authenticated) {
            util.clearCookies(res);
            res.status(401).json(errorResponse);
            return;
          } else { 
            res.status(403).json(errorResponse);
            return;
          }
        } else {
          next();
          return;
        }
      } catch (e) {
        console.warn(e);
        res.status(500).send(e.message);
        return;
      }
    }),
    
  }
};


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
