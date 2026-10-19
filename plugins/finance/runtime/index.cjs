/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 491:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.discriminatedUnion = exports.date = exports.boolean = exports.bigint = exports.array = exports.any = exports.coerce = exports.ZodFirstPartyTypeKind = exports.late = exports.ZodSchema = exports.Schema = exports.ZodReadonly = exports.ZodPipeline = exports.ZodBranded = exports.BRAND = exports.ZodNaN = exports.ZodCatch = exports.ZodDefault = exports.ZodNullable = exports.ZodOptional = exports.ZodTransformer = exports.ZodEffects = exports.ZodPromise = exports.ZodNativeEnum = exports.ZodEnum = exports.ZodLiteral = exports.ZodLazy = exports.ZodFunction = exports.ZodSet = exports.ZodMap = exports.ZodRecord = exports.ZodTuple = exports.ZodIntersection = exports.ZodDiscriminatedUnion = exports.ZodUnion = exports.ZodObject = exports.ZodArray = exports.ZodVoid = exports.ZodNever = exports.ZodUnknown = exports.ZodAny = exports.ZodNull = exports.ZodUndefined = exports.ZodSymbol = exports.ZodDate = exports.ZodBoolean = exports.ZodBigInt = exports.ZodNumber = exports.ZodString = exports.ZodType = void 0;
exports.NEVER = exports["void"] = exports.unknown = exports.union = exports.undefined = exports.tuple = exports.transformer = exports.symbol = exports.string = exports.strictObject = exports.set = exports.record = exports.promise = exports.preprocess = exports.pipeline = exports.ostring = exports.optional = exports.onumber = exports.oboolean = exports.object = exports.number = exports.nullable = exports["null"] = exports.never = exports.nativeEnum = exports.nan = exports.map = exports.literal = exports.lazy = exports.intersection = exports["instanceof"] = exports["function"] = exports["enum"] = exports.effect = void 0;
exports.datetimeRegex = datetimeRegex;
exports.custom = custom;
const ZodError_js_1 = __webpack_require__(8651);
const errors_js_1 = __webpack_require__(9317);
const errorUtil_js_1 = __webpack_require__(3368);
const parseUtil_js_1 = __webpack_require__(819);
const util_js_1 = __webpack_require__(2034);
class ParseInputLazyPath {
    constructor(parent, value, path, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path;
        this._key = key;
    }
    get path() {
        if (!this._cachedPath.length) {
            if (Array.isArray(this._key)) {
                this._cachedPath.push(...this._path, ...this._key);
            }
            else {
                this._cachedPath.push(...this._path, this._key);
            }
        }
        return this._cachedPath;
    }
}
const handleResult = (ctx, result) => {
    if ((0, parseUtil_js_1.isValid)(result)) {
        return { success: true, data: result.value };
    }
    else {
        if (!ctx.common.issues.length) {
            throw new Error("Validation failed but no issues detected.");
        }
        return {
            success: false,
            get error() {
                if (this._error)
                    return this._error;
                const error = new ZodError_js_1.ZodError(ctx.common.issues);
                this._error = error;
                return this._error;
            },
        };
    }
};
function processCreateParams(params) {
    if (!params)
        return {};
    const { errorMap, invalid_type_error, required_error, description } = params;
    if (errorMap && (invalid_type_error || required_error)) {
        throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap)
        return { errorMap: errorMap, description };
    const customMap = (iss, ctx) => {
        const { message } = params;
        if (iss.code === "invalid_enum_value") {
            return { message: message ?? ctx.defaultError };
        }
        if (typeof ctx.data === "undefined") {
            return { message: message ?? required_error ?? ctx.defaultError };
        }
        if (iss.code !== "invalid_type")
            return { message: ctx.defaultError };
        return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
}
class ZodType {
    get description() {
        return this._def.description;
    }
    _getType(input) {
        return (0, util_js_1.getParsedType)(input.data);
    }
    _getOrReturnCtx(input, ctx) {
        return (ctx || {
            common: input.parent.common,
            data: input.data,
            parsedType: (0, util_js_1.getParsedType)(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent,
        });
    }
    _processInputParams(input) {
        return {
            status: new parseUtil_js_1.ParseStatus(),
            ctx: {
                common: input.parent.common,
                data: input.data,
                parsedType: (0, util_js_1.getParsedType)(input.data),
                schemaErrorMap: this._def.errorMap,
                path: input.path,
                parent: input.parent,
            },
        };
    }
    _parseSync(input) {
        const result = this._parse(input);
        if ((0, parseUtil_js_1.isAsync)(result)) {
            throw new Error("Synchronous parse encountered promise.");
        }
        return result;
    }
    _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
    }
    parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    safeParse(data, params) {
        const ctx = {
            common: {
                issues: [],
                async: params?.async ?? false,
                contextualErrorMap: params?.errorMap,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: (0, util_js_1.getParsedType)(data),
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult(ctx, result);
    }
    "~validate"(data) {
        const ctx = {
            common: {
                issues: [],
                async: !!this["~standard"].async,
            },
            path: [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: (0, util_js_1.getParsedType)(data),
        };
        if (!this["~standard"].async) {
            try {
                const result = this._parseSync({ data, path: [], parent: ctx });
                return (0, parseUtil_js_1.isValid)(result)
                    ? {
                        value: result.value,
                    }
                    : {
                        issues: ctx.common.issues,
                    };
            }
            catch (err) {
                if (err?.message?.toLowerCase()?.includes("encountered")) {
                    this["~standard"].async = true;
                }
                ctx.common = {
                    issues: [],
                    async: true,
                };
            }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => (0, parseUtil_js_1.isValid)(result)
            ? {
                value: result.value,
            }
            : {
                issues: ctx.common.issues,
            });
    }
    async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    async safeParseAsync(data, params) {
        const ctx = {
            common: {
                issues: [],
                contextualErrorMap: params?.errorMap,
                async: true,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: (0, util_js_1.getParsedType)(data),
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await ((0, parseUtil_js_1.isAsync)(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult(ctx, result);
    }
    refine(check, message) {
        const getIssueProperties = (val) => {
            if (typeof message === "string" || typeof message === "undefined") {
                return { message };
            }
            else if (typeof message === "function") {
                return message(val);
            }
            else {
                return message;
            }
        };
        return this._refinement((val, ctx) => {
            const result = check(val);
            const setError = () => ctx.addIssue({
                code: ZodError_js_1.ZodIssueCode.custom,
                ...getIssueProperties(val),
            });
            if (typeof Promise !== "undefined" && result instanceof Promise) {
                return result.then((data) => {
                    if (!data) {
                        setError();
                        return false;
                    }
                    else {
                        return true;
                    }
                });
            }
            if (!result) {
                setError();
                return false;
            }
            else {
                return true;
            }
        });
    }
    refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
            if (!check(val)) {
                ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
                return false;
            }
            else {
                return true;
            }
        });
    }
    _refinement(refinement) {
        return new ZodEffects({
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "refinement", refinement },
        });
    }
    superRefine(refinement) {
        return this._refinement(refinement);
    }
    constructor(def) {
        /** Alias of safeParseAsync */
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
            version: 1,
            vendor: "zod",
            validate: (data) => this["~validate"](data),
        };
    }
    optional() {
        return ZodOptional.create(this, this._def);
    }
    nullable() {
        return ZodNullable.create(this, this._def);
    }
    nullish() {
        return this.nullable().optional();
    }
    array() {
        return ZodArray.create(this);
    }
    promise() {
        return ZodPromise.create(this, this._def);
    }
    or(option) {
        return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
        return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
        return new ZodEffects({
            ...processCreateParams(this._def),
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "transform", transform },
        });
    }
    default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault({
            ...processCreateParams(this._def),
            innerType: this,
            defaultValue: defaultValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodDefault,
        });
    }
    brand() {
        return new ZodBranded({
            typeName: ZodFirstPartyTypeKind.ZodBranded,
            type: this,
            ...processCreateParams(this._def),
        });
    }
    catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch({
            ...processCreateParams(this._def),
            innerType: this,
            catchValue: catchValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodCatch,
        });
    }
    describe(description) {
        const This = this.constructor;
        return new This({
            ...this._def,
            description,
        });
    }
    pipe(target) {
        return ZodPipeline.create(this, target);
    }
    readonly() {
        return ZodReadonly.create(this);
    }
    isOptional() {
        return this.safeParse(undefined).success;
    }
    isNullable() {
        return this.safeParse(null).success;
    }
}
exports.ZodType = ZodType;
exports.Schema = ZodType;
exports.ZodSchema = ZodType;
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// const uuidRegex =
//   /^([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000)$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
// from https://stackoverflow.com/a/46181/1550155
// old version: too slow, didn't support unicode
// const emailRegex = /^((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)((((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*(((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))$/i;
//old email regex
// const emailRegex = /^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@((?!-)([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{1,})[^-<>()[\].,;:\s@"]$/i;
// eslint-disable-next-line
// const emailRegex =
//   /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\])|(\[IPv6:(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))\])|([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])*(\.[A-Za-z]{2,})+))$/;
// const emailRegex =
//   /^[a-zA-Z0-9\.\!\#\$\%\&\'\*\+\/\=\?\^\_\`\{\|\}\~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// const emailRegex =
//   /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
// const emailRegex =
//   /^[a-z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9\-]+)*$/i;
// from https://thekevinscott.com/emojis-in-javascript/#writing-a-regular-expression
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
// faster, simpler, safer
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
// const ipv6Regex =
// /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
// https://stackoverflow.com/questions/7860392/determine-if-string-is-in-base64-using-javascript
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
// https://base64.guru/standards/base64url
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
// simple
// const dateRegexSource = `\\d{4}-\\d{2}-\\d{2}`;
// no leap year validation
// const dateRegexSource = `\\d{4}-((0[13578]|10|12)-31|(0[13-9]|1[0-2])-30|(0[1-9]|1[0-2])-(0[1-9]|1\\d|2\\d))`;
// with leap year validation
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
        secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    }
    else if (args.precision == null) {
        secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?"; // require seconds if precision is nonzero
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
}
// Adapted from https://stackoverflow.com/a/3143231
function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
        opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
        return true;
    }
    return false;
}
function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
        return false;
    try {
        const [header] = jwt.split(".");
        if (!header)
            return false;
        // Convert base64url to base64
        const base64 = header
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
        const decoded = JSON.parse(atob(base64));
        if (typeof decoded !== "object" || decoded === null)
            return false;
        if ("typ" in decoded && decoded?.typ !== "JWT")
            return false;
        if (!decoded.alg)
            return false;
        if (alg && decoded.alg !== alg)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
        return true;
    }
    return false;
}
class ZodString extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.string) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.string,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const status = new parseUtil_js_1.ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.length < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.length > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "length") {
                const tooBig = input.data.length > check.value;
                const tooSmall = input.data.length < check.value;
                if (tooBig || tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    if (tooBig) {
                        (0, parseUtil_js_1.addIssueToContext)(ctx, {
                            code: ZodError_js_1.ZodIssueCode.too_big,
                            maximum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    else if (tooSmall) {
                        (0, parseUtil_js_1.addIssueToContext)(ctx, {
                            code: ZodError_js_1.ZodIssueCode.too_small,
                            minimum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    status.dirty();
                }
            }
            else if (check.kind === "email") {
                if (!emailRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "email",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "emoji") {
                if (!emojiRegex) {
                    emojiRegex = new RegExp(_emojiRegex, "u");
                }
                if (!emojiRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "emoji",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "uuid") {
                if (!uuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "uuid",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "nanoid") {
                if (!nanoidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "nanoid",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid") {
                if (!cuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "cuid",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid2") {
                if (!cuid2Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "cuid2",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ulid") {
                if (!ulidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "ulid",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "url") {
                try {
                    new URL(input.data);
                }
                catch {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "url",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "regex") {
                check.regex.lastIndex = 0;
                const testResult = check.regex.test(input.data);
                if (!testResult) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "regex",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "trim") {
                input.data = input.data.trim();
            }
            else if (check.kind === "includes") {
                if (!input.data.includes(check.value, check.position)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: { includes: check.value, position: check.position },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "toLowerCase") {
                input.data = input.data.toLowerCase();
            }
            else if (check.kind === "toUpperCase") {
                input.data = input.data.toUpperCase();
            }
            else if (check.kind === "startsWith") {
                if (!input.data.startsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: { startsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "endsWith") {
                if (!input.data.endsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: { endsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "datetime") {
                const regex = datetimeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: "datetime",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "date") {
                const regex = dateRegex;
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: "date",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "time") {
                const regex = timeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        validation: "time",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "duration") {
                if (!durationRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "duration",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ip") {
                if (!isValidIP(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "ip",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "jwt") {
                if (!isValidJWT(input.data, check.alg)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "jwt",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cidr") {
                if (!isValidCidr(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "cidr",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64") {
                if (!base64Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "base64",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64url") {
                if (!base64urlRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        validation: "base64url",
                        code: ZodError_js_1.ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util_js_1.util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
            validation,
            code: ZodError_js_1.ZodIssueCode.invalid_string,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    _addCheck(check) {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    email(message) {
        return this._addCheck({ kind: "email", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    url(message) {
        return this._addCheck({ kind: "url", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    base64url(message) {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return this._addCheck({
            kind: "base64url",
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil_js_1.errorUtil.errToObj(options) });
    }
    ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil_js_1.errorUtil.errToObj(options) });
    }
    cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil_js_1.errorUtil.errToObj(options) });
    }
    datetime(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "datetime",
                precision: null,
                offset: false,
                local: false,
                message: options,
            });
        }
        return this._addCheck({
            kind: "datetime",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            offset: options?.offset ?? false,
            local: options?.local ?? false,
            ...errorUtil_js_1.errorUtil.errToObj(options?.message),
        });
    }
    date(message) {
        return this._addCheck({ kind: "date", message });
    }
    time(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "time",
                precision: null,
                message: options,
            });
        }
        return this._addCheck({
            kind: "time",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            ...errorUtil_js_1.errorUtil.errToObj(options?.message),
        });
    }
    duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil_js_1.errorUtil.errToObj(message) });
    }
    regex(regex, message) {
        return this._addCheck({
            kind: "regex",
            regex: regex,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    includes(value, options) {
        return this._addCheck({
            kind: "includes",
            value: value,
            position: options?.position,
            ...errorUtil_js_1.errorUtil.errToObj(options?.message),
        });
    }
    startsWith(value, message) {
        return this._addCheck({
            kind: "startsWith",
            value: value,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    endsWith(value, message) {
        return this._addCheck({
            kind: "endsWith",
            value: value,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    min(minLength, message) {
        return this._addCheck({
            kind: "min",
            value: minLength,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    max(maxLength, message) {
        return this._addCheck({
            kind: "max",
            value: maxLength,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    length(len, message) {
        return this._addCheck({
            kind: "length",
            value: len,
            ...errorUtil_js_1.errorUtil.errToObj(message),
        });
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
        return this.min(1, errorUtil_js_1.errorUtil.errToObj(message));
    }
    trim() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "trim" }],
        });
    }
    toLowerCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toLowerCase" }],
        });
    }
    toUpperCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toUpperCase" }],
        });
    }
    get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
exports.ZodString = ZodString;
ZodString.create = (params) => {
    return new ZodString({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
// https://stackoverflow.com/questions/3966484/why-does-modulus-operator-return-fractional-number-in-javascript/31711034#31711034
function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return (valInt % stepInt) / 10 ** decCount;
}
class ZodNumber extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
    }
    _parse(input) {
        if (this._def.coerce) {
            input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.number) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.number,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        let ctx = undefined;
        const status = new parseUtil_js_1.ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "int") {
                if (!util_js_1.util.isInteger(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.invalid_type,
                        expected: "integer",
                        received: "float",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (floatSafeRemainder(input.data, check.value) !== 0) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "finite") {
                if (!Number.isFinite(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.not_finite,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util_js_1.util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil_js_1.errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil_js_1.errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil_js_1.errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil_js_1.errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodNumber({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil_js_1.errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodNumber({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    int(message) {
        return this._addCheck({
            kind: "int",
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: false,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: false,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: true,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: true,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value: value,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    finite(message) {
        return this._addCheck({
            kind: "finite",
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    safe(message) {
        return this._addCheck({
            kind: "min",
            inclusive: true,
            value: Number.MIN_SAFE_INTEGER,
            message: errorUtil_js_1.errorUtil.toString(message),
        })._addCheck({
            kind: "max",
            inclusive: true,
            value: Number.MAX_SAFE_INTEGER,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
    get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || (ch.kind === "multipleOf" && util_js_1.util.isInteger(ch.value)));
    }
    get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
                return true;
            }
            else if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
            else if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max);
    }
}
exports.ZodNumber = ZodNumber;
ZodNumber.create = (params) => {
    return new ZodNumber({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodBigInt extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
    }
    _parse(input) {
        if (this._def.coerce) {
            try {
                input.data = BigInt(input.data);
            }
            catch {
                return this._getInvalidInput(input);
            }
        }
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.bigint) {
            return this._getInvalidInput(input);
        }
        let ctx = undefined;
        const status = new parseUtil_js_1.ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_small,
                        type: "bigint",
                        minimum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_big,
                        type: "bigint",
                        maximum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (input.data % check.value !== BigInt(0)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util_js_1.util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        (0, parseUtil_js_1.addIssueToContext)(ctx, {
            code: ZodError_js_1.ZodIssueCode.invalid_type,
            expected: util_js_1.ZodParsedType.bigint,
            received: ctx.parsedType,
        });
        return parseUtil_js_1.INVALID;
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil_js_1.errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil_js_1.errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil_js_1.errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil_js_1.errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodBigInt({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil_js_1.errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodBigInt({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value,
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
exports.ZodBigInt = ZodBigInt;
ZodBigInt.create = (params) => {
    return new ZodBigInt({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
class ZodBoolean extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.boolean) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.boolean,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodBoolean = ZodBoolean;
ZodBoolean.create = (params) => {
    return new ZodBoolean({
        typeName: ZodFirstPartyTypeKind.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodDate extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.date) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.date,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        if (Number.isNaN(input.data.getTime())) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_date,
            });
            return parseUtil_js_1.INVALID;
        }
        const status = new parseUtil_js_1.ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.getTime() < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_small,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        minimum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.getTime() > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.too_big,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        maximum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else {
                util_js_1.util.assertNever(check);
            }
        }
        return {
            status: status.value,
            value: new Date(input.data.getTime()),
        };
    }
    _addCheck(check) {
        return new ZodDate({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    min(minDate, message) {
        return this._addCheck({
            kind: "min",
            value: minDate.getTime(),
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    max(maxDate, message) {
        return this._addCheck({
            kind: "max",
            value: maxDate.getTime(),
            message: errorUtil_js_1.errorUtil.toString(message),
        });
    }
    get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min != null ? new Date(min) : null;
    }
    get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max != null ? new Date(max) : null;
    }
}
exports.ZodDate = ZodDate;
ZodDate.create = (params) => {
    return new ZodDate({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind.ZodDate,
        ...processCreateParams(params),
    });
};
class ZodSymbol extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.symbol) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.symbol,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodSymbol = ZodSymbol;
ZodSymbol.create = (params) => {
    return new ZodSymbol({
        typeName: ZodFirstPartyTypeKind.ZodSymbol,
        ...processCreateParams(params),
    });
};
class ZodUndefined extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.undefined,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodUndefined = ZodUndefined;
ZodUndefined.create = (params) => {
    return new ZodUndefined({
        typeName: ZodFirstPartyTypeKind.ZodUndefined,
        ...processCreateParams(params),
    });
};
class ZodNull extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.null) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.null,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodNull = ZodNull;
ZodNull.create = (params) => {
    return new ZodNull({
        typeName: ZodFirstPartyTypeKind.ZodNull,
        ...processCreateParams(params),
    });
};
class ZodAny extends ZodType {
    constructor() {
        super(...arguments);
        // to prevent instances of other classes from extending ZodAny. this causes issues with catchall in ZodObject.
        this._any = true;
    }
    _parse(input) {
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodAny = ZodAny;
ZodAny.create = (params) => {
    return new ZodAny({
        typeName: ZodFirstPartyTypeKind.ZodAny,
        ...processCreateParams(params),
    });
};
class ZodUnknown extends ZodType {
    constructor() {
        super(...arguments);
        // required
        this._unknown = true;
    }
    _parse(input) {
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodUnknown = ZodUnknown;
ZodUnknown.create = (params) => {
    return new ZodUnknown({
        typeName: ZodFirstPartyTypeKind.ZodUnknown,
        ...processCreateParams(params),
    });
};
class ZodNever extends ZodType {
    _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        (0, parseUtil_js_1.addIssueToContext)(ctx, {
            code: ZodError_js_1.ZodIssueCode.invalid_type,
            expected: util_js_1.ZodParsedType.never,
            received: ctx.parsedType,
        });
        return parseUtil_js_1.INVALID;
    }
}
exports.ZodNever = ZodNever;
ZodNever.create = (params) => {
    return new ZodNever({
        typeName: ZodFirstPartyTypeKind.ZodNever,
        ...processCreateParams(params),
    });
};
class ZodVoid extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.void,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
}
exports.ZodVoid = ZodVoid;
ZodVoid.create = (params) => {
    return new ZodVoid({
        typeName: ZodFirstPartyTypeKind.ZodVoid,
        ...processCreateParams(params),
    });
};
class ZodArray extends ZodType {
    _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== util_js_1.ZodParsedType.array) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.array,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        if (def.exactLength !== null) {
            const tooBig = ctx.data.length > def.exactLength.value;
            const tooSmall = ctx.data.length < def.exactLength.value;
            if (tooBig || tooSmall) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: tooBig ? ZodError_js_1.ZodIssueCode.too_big : ZodError_js_1.ZodIssueCode.too_small,
                    minimum: (tooSmall ? def.exactLength.value : undefined),
                    maximum: (tooBig ? def.exactLength.value : undefined),
                    type: "array",
                    inclusive: true,
                    exact: true,
                    message: def.exactLength.message,
                });
                status.dirty();
            }
        }
        if (def.minLength !== null) {
            if (ctx.data.length < def.minLength.value) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: ZodError_js_1.ZodIssueCode.too_small,
                    minimum: def.minLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.minLength.message,
                });
                status.dirty();
            }
        }
        if (def.maxLength !== null) {
            if (ctx.data.length > def.maxLength.value) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: ZodError_js_1.ZodIssueCode.too_big,
                    maximum: def.maxLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.maxLength.message,
                });
                status.dirty();
            }
        }
        if (ctx.common.async) {
            return Promise.all([...ctx.data].map((item, i) => {
                return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
            })).then((result) => {
                return parseUtil_js_1.ParseStatus.mergeArray(status, result);
            });
        }
        const result = [...ctx.data].map((item, i) => {
            return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        });
        return parseUtil_js_1.ParseStatus.mergeArray(status, result);
    }
    get element() {
        return this._def.type;
    }
    min(minLength, message) {
        return new ZodArray({
            ...this._def,
            minLength: { value: minLength, message: errorUtil_js_1.errorUtil.toString(message) },
        });
    }
    max(maxLength, message) {
        return new ZodArray({
            ...this._def,
            maxLength: { value: maxLength, message: errorUtil_js_1.errorUtil.toString(message) },
        });
    }
    length(len, message) {
        return new ZodArray({
            ...this._def,
            exactLength: { value: len, message: errorUtil_js_1.errorUtil.toString(message) },
        });
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
exports.ZodArray = ZodArray;
ZodArray.create = (schema, params) => {
    return new ZodArray({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind.ZodArray,
        ...processCreateParams(params),
    });
};
function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
        const newShape = {};
        for (const key in schema.shape) {
            const fieldSchema = schema.shape[key];
            newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
        }
        return new ZodObject({
            ...schema._def,
            shape: () => newShape,
        });
    }
    else if (schema instanceof ZodArray) {
        return new ZodArray({
            ...schema._def,
            type: deepPartialify(schema.element),
        });
    }
    else if (schema instanceof ZodOptional) {
        return ZodOptional.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodNullable) {
        return ZodNullable.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodTuple) {
        return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    }
    else {
        return schema;
    }
}
class ZodObject extends ZodType {
    constructor() {
        super(...arguments);
        this._cached = null;
        /**
         * @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
         * If you want to pass through unknown properties, use `.passthrough()` instead.
         */
        this.nonstrict = this.passthrough;
        // extend<
        //   Augmentation extends ZodRawShape,
        //   NewOutput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
        //       ? Augmentation[k]["_output"]
        //       : k extends keyof Output
        //       ? Output[k]
        //       : never;
        //   }>,
        //   NewInput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
        //       ? Augmentation[k]["_input"]
        //       : k extends keyof Input
        //       ? Input[k]
        //       : never;
        //   }>
        // >(
        //   augmentation: Augmentation
        // ): ZodObject<
        //   extendShape<T, Augmentation>,
        //   UnknownKeys,
        //   Catchall,
        //   NewOutput,
        //   NewInput
        // > {
        //   return new ZodObject({
        //     ...this._def,
        //     shape: () => ({
        //       ...this._def.shape(),
        //       ...augmentation,
        //     }),
        //   }) as any;
        // }
        /**
         * @deprecated Use `.extend` instead
         *  */
        this.augment = this.extend;
    }
    _getCached() {
        if (this._cached !== null)
            return this._cached;
        const shape = this._def.shape();
        const keys = util_js_1.util.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
    }
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.object) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.object,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
            for (const key in ctx.data) {
                if (!shapeKeys.includes(key)) {
                    extraKeys.push(key);
                }
            }
        }
        const pairs = [];
        for (const key of shapeKeys) {
            const keyValidator = shape[key];
            const value = ctx.data[key];
            pairs.push({
                key: { status: "valid", value: key },
                value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (this._def.catchall instanceof ZodNever) {
            const unknownKeys = this._def.unknownKeys;
            if (unknownKeys === "passthrough") {
                for (const key of extraKeys) {
                    pairs.push({
                        key: { status: "valid", value: key },
                        value: { status: "valid", value: ctx.data[key] },
                    });
                }
            }
            else if (unknownKeys === "strict") {
                if (extraKeys.length > 0) {
                    (0, parseUtil_js_1.addIssueToContext)(ctx, {
                        code: ZodError_js_1.ZodIssueCode.unrecognized_keys,
                        keys: extraKeys,
                    });
                    status.dirty();
                }
            }
            else if (unknownKeys === "strip") {
            }
            else {
                throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
            }
        }
        else {
            // run catchall validation
            const catchall = this._def.catchall;
            for (const key of extraKeys) {
                const value = ctx.data[key];
                pairs.push({
                    key: { status: "valid", value: key },
                    value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key) //, ctx.child(key), value, getParsedType(value)
                    ),
                    alwaysSet: key in ctx.data,
                });
            }
        }
        if (ctx.common.async) {
            return Promise.resolve()
                .then(async () => {
                const syncPairs = [];
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    syncPairs.push({
                        key,
                        value,
                        alwaysSet: pair.alwaysSet,
                    });
                }
                return syncPairs;
            })
                .then((syncPairs) => {
                return parseUtil_js_1.ParseStatus.mergeObjectSync(status, syncPairs);
            });
        }
        else {
            return parseUtil_js_1.ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get shape() {
        return this._def.shape();
    }
    strict(message) {
        errorUtil_js_1.errorUtil.errToObj;
        return new ZodObject({
            ...this._def,
            unknownKeys: "strict",
            ...(message !== undefined
                ? {
                    errorMap: (issue, ctx) => {
                        const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
                        if (issue.code === "unrecognized_keys")
                            return {
                                message: errorUtil_js_1.errorUtil.errToObj(message).message ?? defaultError,
                            };
                        return {
                            message: defaultError,
                        };
                    },
                }
                : {}),
        });
    }
    strip() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "strip",
        });
    }
    passthrough() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "passthrough",
        });
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
        return new ZodObject({
            ...this._def,
            shape: () => ({
                ...this._def.shape(),
                ...augmentation,
            }),
        });
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
        const merged = new ZodObject({
            unknownKeys: merging._def.unknownKeys,
            catchall: merging._def.catchall,
            shape: () => ({
                ...this._def.shape(),
                ...merging._def.shape(),
            }),
            typeName: ZodFirstPartyTypeKind.ZodObject,
        });
        return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
        return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
        return new ZodObject({
            ...this._def,
            catchall: index,
        });
    }
    pick(mask) {
        const shape = {};
        for (const key of util_js_1.util.objectKeys(mask)) {
            if (mask[key] && this.shape[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    omit(mask) {
        const shape = {};
        for (const key of util_js_1.util.objectKeys(this.shape)) {
            if (!mask[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    /**
     * @deprecated
     */
    deepPartial() {
        return deepPartialify(this);
    }
    partial(mask) {
        const newShape = {};
        for (const key of util_js_1.util.objectKeys(this.shape)) {
            const fieldSchema = this.shape[key];
            if (mask && !mask[key]) {
                newShape[key] = fieldSchema;
            }
            else {
                newShape[key] = fieldSchema.optional();
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    required(mask) {
        const newShape = {};
        for (const key of util_js_1.util.objectKeys(this.shape)) {
            if (mask && !mask[key]) {
                newShape[key] = this.shape[key];
            }
            else {
                const fieldSchema = this.shape[key];
                let newField = fieldSchema;
                while (newField instanceof ZodOptional) {
                    newField = newField._def.innerType;
                }
                newShape[key] = newField;
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    keyof() {
        return createZodEnum(util_js_1.util.objectKeys(this.shape));
    }
}
exports.ZodObject = ZodObject;
ZodObject.create = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.strictCreate = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.lazycreate = (shape, params) => {
    return new ZodObject({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
class ZodUnion extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
            // return first issue-free validation if it exists
            for (const result of results) {
                if (result.result.status === "valid") {
                    return result.result;
                }
            }
            for (const result of results) {
                if (result.result.status === "dirty") {
                    // add issues from dirty option
                    ctx.common.issues.push(...result.ctx.common.issues);
                    return result.result;
                }
            }
            // return invalid
            const unionErrors = results.map((result) => new ZodError_js_1.ZodError(result.ctx.common.issues));
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_union,
                unionErrors,
            });
            return parseUtil_js_1.INVALID;
        }
        if (ctx.common.async) {
            return Promise.all(options.map(async (option) => {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                return {
                    result: await option._parseAsync({
                        data: ctx.data,
                        path: ctx.path,
                        parent: childCtx,
                    }),
                    ctx: childCtx,
                };
            })).then(handleResults);
        }
        else {
            let dirty = undefined;
            const issues = [];
            for (const option of options) {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                const result = option._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: childCtx,
                });
                if (result.status === "valid") {
                    return result;
                }
                else if (result.status === "dirty" && !dirty) {
                    dirty = { result, ctx: childCtx };
                }
                if (childCtx.common.issues.length) {
                    issues.push(childCtx.common.issues);
                }
            }
            if (dirty) {
                ctx.common.issues.push(...dirty.ctx.common.issues);
                return dirty.result;
            }
            const unionErrors = issues.map((issues) => new ZodError_js_1.ZodError(issues));
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_union,
                unionErrors,
            });
            return parseUtil_js_1.INVALID;
        }
    }
    get options() {
        return this._def.options;
    }
}
exports.ZodUnion = ZodUnion;
ZodUnion.create = (types, params) => {
    return new ZodUnion({
        options: types,
        typeName: ZodFirstPartyTypeKind.ZodUnion,
        ...processCreateParams(params),
    });
};
/////////////////////////////////////////////////////
/////////////////////////////////////////////////////
//////////                                 //////////
//////////      ZodDiscriminatedUnion      //////////
//////////                                 //////////
/////////////////////////////////////////////////////
/////////////////////////////////////////////////////
const getDiscriminator = (type) => {
    if (type instanceof ZodLazy) {
        return getDiscriminator(type.schema);
    }
    else if (type instanceof ZodEffects) {
        return getDiscriminator(type.innerType());
    }
    else if (type instanceof ZodLiteral) {
        return [type.value];
    }
    else if (type instanceof ZodEnum) {
        return type.options;
    }
    else if (type instanceof ZodNativeEnum) {
        // eslint-disable-next-line ban/ban
        return util_js_1.util.objectValues(type.enum);
    }
    else if (type instanceof ZodDefault) {
        return getDiscriminator(type._def.innerType);
    }
    else if (type instanceof ZodUndefined) {
        return [undefined];
    }
    else if (type instanceof ZodNull) {
        return [null];
    }
    else if (type instanceof ZodOptional) {
        return [undefined, ...getDiscriminator(type.unwrap())];
    }
    else if (type instanceof ZodNullable) {
        return [null, ...getDiscriminator(type.unwrap())];
    }
    else if (type instanceof ZodBranded) {
        return getDiscriminator(type.unwrap());
    }
    else if (type instanceof ZodReadonly) {
        return getDiscriminator(type.unwrap());
    }
    else if (type instanceof ZodCatch) {
        return getDiscriminator(type._def.innerType);
    }
    else {
        return [];
    }
};
class ZodDiscriminatedUnion extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.object) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.object,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const discriminator = this.discriminator;
        const discriminatorValue = ctx.data[discriminator];
        const option = this.optionsMap.get(discriminatorValue);
        if (!option) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_union_discriminator,
                options: Array.from(this.optionsMap.keys()),
                path: [discriminator],
            });
            return parseUtil_js_1.INVALID;
        }
        if (ctx.common.async) {
            return option._parseAsync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
        }
        else {
            return option._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
        }
    }
    get discriminator() {
        return this._def.discriminator;
    }
    get options() {
        return this._def.options;
    }
    get optionsMap() {
        return this._def.optionsMap;
    }
    /**
     * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
     * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
     * have a different value for each object in the union.
     * @param discriminator the name of the discriminator property
     * @param types an array of object schemas
     * @param params
     */
    static create(discriminator, options, params) {
        // Get all the valid discriminator values
        const optionsMap = new Map();
        // try {
        for (const type of options) {
            const discriminatorValues = getDiscriminator(type.shape[discriminator]);
            if (!discriminatorValues.length) {
                throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
            }
            for (const value of discriminatorValues) {
                if (optionsMap.has(value)) {
                    throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
                }
                optionsMap.set(value, type);
            }
        }
        return new ZodDiscriminatedUnion({
            typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
            discriminator,
            options,
            optionsMap,
            ...processCreateParams(params),
        });
    }
}
exports.ZodDiscriminatedUnion = ZodDiscriminatedUnion;
function mergeValues(a, b) {
    const aType = (0, util_js_1.getParsedType)(a);
    const bType = (0, util_js_1.getParsedType)(b);
    if (a === b) {
        return { valid: true, data: a };
    }
    else if (aType === util_js_1.ZodParsedType.object && bType === util_js_1.ZodParsedType.object) {
        const bKeys = util_js_1.util.objectKeys(b);
        const sharedKeys = util_js_1.util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
        const newObj = { ...a, ...b };
        for (const key of sharedKeys) {
            const sharedValue = mergeValues(a[key], b[key]);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newObj[key] = sharedValue.data;
        }
        return { valid: true, data: newObj };
    }
    else if (aType === util_js_1.ZodParsedType.array && bType === util_js_1.ZodParsedType.array) {
        if (a.length !== b.length) {
            return { valid: false };
        }
        const newArray = [];
        for (let index = 0; index < a.length; index++) {
            const itemA = a[index];
            const itemB = b[index];
            const sharedValue = mergeValues(itemA, itemB);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newArray.push(sharedValue.data);
        }
        return { valid: true, data: newArray };
    }
    else if (aType === util_js_1.ZodParsedType.date && bType === util_js_1.ZodParsedType.date && +a === +b) {
        return { valid: true, data: a };
    }
    else {
        return { valid: false };
    }
}
class ZodIntersection extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
            if ((0, parseUtil_js_1.isAborted)(parsedLeft) || (0, parseUtil_js_1.isAborted)(parsedRight)) {
                return parseUtil_js_1.INVALID;
            }
            const merged = mergeValues(parsedLeft.value, parsedRight.value);
            if (!merged.valid) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: ZodError_js_1.ZodIssueCode.invalid_intersection_types,
                });
                return parseUtil_js_1.INVALID;
            }
            if ((0, parseUtil_js_1.isDirty)(parsedLeft) || (0, parseUtil_js_1.isDirty)(parsedRight)) {
                status.dirty();
            }
            return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
            return Promise.all([
                this._def.left._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
                this._def.right._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
            ]).then(([left, right]) => handleParsed(left, right));
        }
        else {
            return handleParsed(this._def.left._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }), this._def.right._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }));
        }
    }
}
exports.ZodIntersection = ZodIntersection;
ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection({
        left: left,
        right: right,
        typeName: ZodFirstPartyTypeKind.ZodIntersection,
        ...processCreateParams(params),
    });
};
// type ZodTupleItems = [ZodTypeAny, ...ZodTypeAny[]];
class ZodTuple extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.array) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.array,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        if (ctx.data.length < this._def.items.length) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.too_small,
                minimum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            return parseUtil_js_1.INVALID;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.too_big,
                maximum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            status.dirty();
        }
        const items = [...ctx.data]
            .map((item, itemIndex) => {
            const schema = this._def.items[itemIndex] || this._def.rest;
            if (!schema)
                return null;
            return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
        })
            .filter((x) => !!x); // filter nulls
        if (ctx.common.async) {
            return Promise.all(items).then((results) => {
                return parseUtil_js_1.ParseStatus.mergeArray(status, results);
            });
        }
        else {
            return parseUtil_js_1.ParseStatus.mergeArray(status, items);
        }
    }
    get items() {
        return this._def.items;
    }
    rest(rest) {
        return new ZodTuple({
            ...this._def,
            rest,
        });
    }
}
exports.ZodTuple = ZodTuple;
ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple({
        items: schemas,
        typeName: ZodFirstPartyTypeKind.ZodTuple,
        rest: null,
        ...processCreateParams(params),
    });
};
class ZodRecord extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.object) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.object,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
            pairs.push({
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
                value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (ctx.common.async) {
            return parseUtil_js_1.ParseStatus.mergeObjectAsync(status, pairs);
        }
        else {
            return parseUtil_js_1.ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get element() {
        return this._def.valueType;
    }
    static create(first, second, third) {
        if (second instanceof ZodType) {
            return new ZodRecord({
                keyType: first,
                valueType: second,
                typeName: ZodFirstPartyTypeKind.ZodRecord,
                ...processCreateParams(third),
            });
        }
        return new ZodRecord({
            keyType: ZodString.create(),
            valueType: first,
            typeName: ZodFirstPartyTypeKind.ZodRecord,
            ...processCreateParams(second),
        });
    }
}
exports.ZodRecord = ZodRecord;
class ZodMap extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.map) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.map,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
            return {
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
                value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"])),
            };
        });
        if (ctx.common.async) {
            const finalMap = new Map();
            return Promise.resolve().then(async () => {
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    if (key.status === "aborted" || value.status === "aborted") {
                        return parseUtil_js_1.INVALID;
                    }
                    if (key.status === "dirty" || value.status === "dirty") {
                        status.dirty();
                    }
                    finalMap.set(key.value, value.value);
                }
                return { status: status.value, value: finalMap };
            });
        }
        else {
            const finalMap = new Map();
            for (const pair of pairs) {
                const key = pair.key;
                const value = pair.value;
                if (key.status === "aborted" || value.status === "aborted") {
                    return parseUtil_js_1.INVALID;
                }
                if (key.status === "dirty" || value.status === "dirty") {
                    status.dirty();
                }
                finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
        }
    }
}
exports.ZodMap = ZodMap;
ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind.ZodMap,
        ...processCreateParams(params),
    });
};
class ZodSet extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.set) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.set,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const def = this._def;
        if (def.minSize !== null) {
            if (ctx.data.size < def.minSize.value) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: ZodError_js_1.ZodIssueCode.too_small,
                    minimum: def.minSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.minSize.message,
                });
                status.dirty();
            }
        }
        if (def.maxSize !== null) {
            if (ctx.data.size > def.maxSize.value) {
                (0, parseUtil_js_1.addIssueToContext)(ctx, {
                    code: ZodError_js_1.ZodIssueCode.too_big,
                    maximum: def.maxSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.maxSize.message,
                });
                status.dirty();
            }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements) {
            const parsedSet = new Set();
            for (const element of elements) {
                if (element.status === "aborted")
                    return parseUtil_js_1.INVALID;
                if (element.status === "dirty")
                    status.dirty();
                parsedSet.add(element.value);
            }
            return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
            return Promise.all(elements).then((elements) => finalizeSet(elements));
        }
        else {
            return finalizeSet(elements);
        }
    }
    min(minSize, message) {
        return new ZodSet({
            ...this._def,
            minSize: { value: minSize, message: errorUtil_js_1.errorUtil.toString(message) },
        });
    }
    max(maxSize, message) {
        return new ZodSet({
            ...this._def,
            maxSize: { value: maxSize, message: errorUtil_js_1.errorUtil.toString(message) },
        });
    }
    size(size, message) {
        return this.min(size, message).max(size, message);
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
exports.ZodSet = ZodSet;
ZodSet.create = (valueType, params) => {
    return new ZodSet({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind.ZodSet,
        ...processCreateParams(params),
    });
};
class ZodFunction extends ZodType {
    constructor() {
        super(...arguments);
        this.validate = this.implement;
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.function) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.function,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        function makeArgsIssue(args, error) {
            return (0, parseUtil_js_1.makeIssue)({
                data: args,
                path: ctx.path,
                errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, (0, errors_js_1.getErrorMap)(), errors_js_1.defaultErrorMap].filter((x) => !!x),
                issueData: {
                    code: ZodError_js_1.ZodIssueCode.invalid_arguments,
                    argumentsError: error,
                },
            });
        }
        function makeReturnsIssue(returns, error) {
            return (0, parseUtil_js_1.makeIssue)({
                data: returns,
                path: ctx.path,
                errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, (0, errors_js_1.getErrorMap)(), errors_js_1.defaultErrorMap].filter((x) => !!x),
                issueData: {
                    code: ZodError_js_1.ZodIssueCode.invalid_return_type,
                    returnTypeError: error,
                },
            });
        }
        const params = { errorMap: ctx.common.contextualErrorMap };
        const fn = ctx.data;
        if (this._def.returns instanceof ZodPromise) {
            // Would love a way to avoid disabling this rule, but we need
            // an alias (using an arrow function was what caused 2651).
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const me = this;
            return (0, parseUtil_js_1.OK)(async function (...args) {
                const error = new ZodError_js_1.ZodError([]);
                const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
                    error.addIssue(makeArgsIssue(args, e));
                    throw error;
                });
                const result = await Reflect.apply(fn, this, parsedArgs);
                const parsedReturns = await me._def.returns._def.type
                    .parseAsync(result, params)
                    .catch((e) => {
                    error.addIssue(makeReturnsIssue(result, e));
                    throw error;
                });
                return parsedReturns;
            });
        }
        else {
            // Would love a way to avoid disabling this rule, but we need
            // an alias (using an arrow function was what caused 2651).
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const me = this;
            return (0, parseUtil_js_1.OK)(function (...args) {
                const parsedArgs = me._def.args.safeParse(args, params);
                if (!parsedArgs.success) {
                    throw new ZodError_js_1.ZodError([makeArgsIssue(args, parsedArgs.error)]);
                }
                const result = Reflect.apply(fn, this, parsedArgs.data);
                const parsedReturns = me._def.returns.safeParse(result, params);
                if (!parsedReturns.success) {
                    throw new ZodError_js_1.ZodError([makeReturnsIssue(result, parsedReturns.error)]);
                }
                return parsedReturns.data;
            });
        }
    }
    parameters() {
        return this._def.args;
    }
    returnType() {
        return this._def.returns;
    }
    args(...items) {
        return new ZodFunction({
            ...this._def,
            args: ZodTuple.create(items).rest(ZodUnknown.create()),
        });
    }
    returns(returnType) {
        return new ZodFunction({
            ...this._def,
            returns: returnType,
        });
    }
    implement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
    }
    strictImplement(func) {
        const validatedFunc = this.parse(func);
        return validatedFunc;
    }
    static create(args, returns, params) {
        return new ZodFunction({
            args: (args ? args : ZodTuple.create([]).rest(ZodUnknown.create())),
            returns: returns || ZodUnknown.create(),
            typeName: ZodFirstPartyTypeKind.ZodFunction,
            ...processCreateParams(params),
        });
    }
}
exports.ZodFunction = ZodFunction;
class ZodLazy extends ZodType {
    get schema() {
        return this._def.getter();
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
}
exports.ZodLazy = ZodLazy;
ZodLazy.create = (getter, params) => {
    return new ZodLazy({
        getter: getter,
        typeName: ZodFirstPartyTypeKind.ZodLazy,
        ...processCreateParams(params),
    });
};
class ZodLiteral extends ZodType {
    _parse(input) {
        if (input.data !== this._def.value) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                received: ctx.data,
                code: ZodError_js_1.ZodIssueCode.invalid_literal,
                expected: this._def.value,
            });
            return parseUtil_js_1.INVALID;
        }
        return { status: "valid", value: input.data };
    }
    get value() {
        return this._def.value;
    }
}
exports.ZodLiteral = ZodLiteral;
ZodLiteral.create = (value, params) => {
    return new ZodLiteral({
        value: value,
        typeName: ZodFirstPartyTypeKind.ZodLiteral,
        ...processCreateParams(params),
    });
};
function createZodEnum(values, params) {
    return new ZodEnum({
        values,
        typeName: ZodFirstPartyTypeKind.ZodEnum,
        ...processCreateParams(params),
    });
}
class ZodEnum extends ZodType {
    _parse(input) {
        if (typeof input.data !== "string") {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                expected: util_js_1.util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodError_js_1.ZodIssueCode.invalid_type,
            });
            return parseUtil_js_1.INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                received: ctx.data,
                code: ZodError_js_1.ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
    get options() {
        return this._def.values;
    }
    get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    extract(values, newDef = this._def) {
        return ZodEnum.create(values, {
            ...this._def,
            ...newDef,
        });
    }
    exclude(values, newDef = this._def) {
        return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
            ...this._def,
            ...newDef,
        });
    }
}
exports.ZodEnum = ZodEnum;
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
    _parse(input) {
        const nativeEnumValues = util_js_1.util.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.string && ctx.parsedType !== util_js_1.ZodParsedType.number) {
            const expectedValues = util_js_1.util.objectValues(nativeEnumValues);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                expected: util_js_1.util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodError_js_1.ZodIssueCode.invalid_type,
            });
            return parseUtil_js_1.INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(util_js_1.util.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
            const expectedValues = util_js_1.util.objectValues(nativeEnumValues);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                received: ctx.data,
                code: ZodError_js_1.ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return parseUtil_js_1.INVALID;
        }
        return (0, parseUtil_js_1.OK)(input.data);
    }
    get enum() {
        return this._def.values;
    }
}
exports.ZodNativeEnum = ZodNativeEnum;
ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum({
        values: values,
        typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
        ...processCreateParams(params),
    });
};
class ZodPromise extends ZodType {
    unwrap() {
        return this._def.type;
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== util_js_1.ZodParsedType.promise && ctx.common.async === false) {
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.promise,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        const promisified = ctx.parsedType === util_js_1.ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
        return (0, parseUtil_js_1.OK)(promisified.then((data) => {
            return this._def.type.parseAsync(data, {
                path: ctx.path,
                errorMap: ctx.common.contextualErrorMap,
            });
        }));
    }
}
exports.ZodPromise = ZodPromise;
ZodPromise.create = (schema, params) => {
    return new ZodPromise({
        type: schema,
        typeName: ZodFirstPartyTypeKind.ZodPromise,
        ...processCreateParams(params),
    });
};
class ZodEffects extends ZodType {
    innerType() {
        return this._def.schema;
    }
    sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
            ? this._def.schema.sourceType()
            : this._def.schema;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
            addIssue: (arg) => {
                (0, parseUtil_js_1.addIssueToContext)(ctx, arg);
                if (arg.fatal) {
                    status.abort();
                }
                else {
                    status.dirty();
                }
            },
            get path() {
                return ctx.path;
            },
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
            const processed = effect.transform(ctx.data, checkCtx);
            if (ctx.common.async) {
                return Promise.resolve(processed).then(async (processed) => {
                    if (status.value === "aborted")
                        return parseUtil_js_1.INVALID;
                    const result = await this._def.schema._parseAsync({
                        data: processed,
                        path: ctx.path,
                        parent: ctx,
                    });
                    if (result.status === "aborted")
                        return parseUtil_js_1.INVALID;
                    if (result.status === "dirty")
                        return (0, parseUtil_js_1.DIRTY)(result.value);
                    if (status.value === "dirty")
                        return (0, parseUtil_js_1.DIRTY)(result.value);
                    return result;
                });
            }
            else {
                if (status.value === "aborted")
                    return parseUtil_js_1.INVALID;
                const result = this._def.schema._parseSync({
                    data: processed,
                    path: ctx.path,
                    parent: ctx,
                });
                if (result.status === "aborted")
                    return parseUtil_js_1.INVALID;
                if (result.status === "dirty")
                    return (0, parseUtil_js_1.DIRTY)(result.value);
                if (status.value === "dirty")
                    return (0, parseUtil_js_1.DIRTY)(result.value);
                return result;
            }
        }
        if (effect.type === "refinement") {
            const executeRefinement = (acc) => {
                const result = effect.refinement(acc, checkCtx);
                if (ctx.common.async) {
                    return Promise.resolve(result);
                }
                if (result instanceof Promise) {
                    throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
                }
                return acc;
            };
            if (ctx.common.async === false) {
                const inner = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inner.status === "aborted")
                    return parseUtil_js_1.INVALID;
                if (inner.status === "dirty")
                    status.dirty();
                // return value is ignored
                executeRefinement(inner.value);
                return { status: status.value, value: inner.value };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
                    if (inner.status === "aborted")
                        return parseUtil_js_1.INVALID;
                    if (inner.status === "dirty")
                        status.dirty();
                    return executeRefinement(inner.value).then(() => {
                        return { status: status.value, value: inner.value };
                    });
                });
            }
        }
        if (effect.type === "transform") {
            if (ctx.common.async === false) {
                const base = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (!(0, parseUtil_js_1.isValid)(base))
                    return parseUtil_js_1.INVALID;
                const result = effect.transform(base.value, checkCtx);
                if (result instanceof Promise) {
                    throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
                }
                return { status: status.value, value: result };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
                    if (!(0, parseUtil_js_1.isValid)(base))
                        return parseUtil_js_1.INVALID;
                    return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
                        status: status.value,
                        value: result,
                    }));
                });
            }
        }
        util_js_1.util.assertNever(effect);
    }
}
exports.ZodEffects = ZodEffects;
exports.ZodTransformer = ZodEffects;
ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects({
        schema,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect,
        ...processCreateParams(params),
    });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        ...processCreateParams(params),
    });
};
class ZodOptional extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === util_js_1.ZodParsedType.undefined) {
            return (0, parseUtil_js_1.OK)(undefined);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
exports.ZodOptional = ZodOptional;
ZodOptional.create = (type, params) => {
    return new ZodOptional({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodOptional,
        ...processCreateParams(params),
    });
};
class ZodNullable extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === util_js_1.ZodParsedType.null) {
            return (0, parseUtil_js_1.OK)(null);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
exports.ZodNullable = ZodNullable;
ZodNullable.create = (type, params) => {
    return new ZodNullable({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodNullable,
        ...processCreateParams(params),
    });
};
class ZodDefault extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === util_js_1.ZodParsedType.undefined) {
            data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    removeDefault() {
        return this._def.innerType;
    }
}
exports.ZodDefault = ZodDefault;
ZodDefault.create = (type, params) => {
    return new ZodDefault({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams(params),
    });
};
class ZodCatch extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        // newCtx is used to not collect issues from inner types in ctx
        const newCtx = {
            ...ctx,
            common: {
                ...ctx.common,
                issues: [],
            },
        };
        const result = this._def.innerType._parse({
            data: newCtx.data,
            path: newCtx.path,
            parent: {
                ...newCtx,
            },
        });
        if ((0, parseUtil_js_1.isAsync)(result)) {
            return result.then((result) => {
                return {
                    status: "valid",
                    value: result.status === "valid"
                        ? result.value
                        : this._def.catchValue({
                            get error() {
                                return new ZodError_js_1.ZodError(newCtx.common.issues);
                            },
                            input: newCtx.data,
                        }),
                };
            });
        }
        else {
            return {
                status: "valid",
                value: result.status === "valid"
                    ? result.value
                    : this._def.catchValue({
                        get error() {
                            return new ZodError_js_1.ZodError(newCtx.common.issues);
                        },
                        input: newCtx.data,
                    }),
            };
        }
    }
    removeCatch() {
        return this._def.innerType;
    }
}
exports.ZodCatch = ZodCatch;
ZodCatch.create = (type, params) => {
    return new ZodCatch({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams(params),
    });
};
class ZodNaN extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== util_js_1.ZodParsedType.nan) {
            const ctx = this._getOrReturnCtx(input);
            (0, parseUtil_js_1.addIssueToContext)(ctx, {
                code: ZodError_js_1.ZodIssueCode.invalid_type,
                expected: util_js_1.ZodParsedType.nan,
                received: ctx.parsedType,
            });
            return parseUtil_js_1.INVALID;
        }
        return { status: "valid", value: input.data };
    }
}
exports.ZodNaN = ZodNaN;
ZodNaN.create = (params) => {
    return new ZodNaN({
        typeName: ZodFirstPartyTypeKind.ZodNaN,
        ...processCreateParams(params),
    });
};
exports.BRAND = Symbol("zod_brand");
class ZodBranded extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    unwrap() {
        return this._def.type;
    }
}
exports.ZodBranded = ZodBranded;
class ZodPipeline extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
            const handleAsync = async () => {
                const inResult = await this._def.in._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inResult.status === "aborted")
                    return parseUtil_js_1.INVALID;
                if (inResult.status === "dirty") {
                    status.dirty();
                    return (0, parseUtil_js_1.DIRTY)(inResult.value);
                }
                else {
                    return this._def.out._parseAsync({
                        data: inResult.value,
                        path: ctx.path,
                        parent: ctx,
                    });
                }
            };
            return handleAsync();
        }
        else {
            const inResult = this._def.in._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
            if (inResult.status === "aborted")
                return parseUtil_js_1.INVALID;
            if (inResult.status === "dirty") {
                status.dirty();
                return {
                    status: "dirty",
                    value: inResult.value,
                };
            }
            else {
                return this._def.out._parseSync({
                    data: inResult.value,
                    path: ctx.path,
                    parent: ctx,
                });
            }
        }
    }
    static create(a, b) {
        return new ZodPipeline({
            in: a,
            out: b,
            typeName: ZodFirstPartyTypeKind.ZodPipeline,
        });
    }
}
exports.ZodPipeline = ZodPipeline;
class ZodReadonly extends ZodType {
    _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
            if ((0, parseUtil_js_1.isValid)(data)) {
                data.value = Object.freeze(data.value);
            }
            return data;
        };
        return (0, parseUtil_js_1.isAsync)(result) ? result.then((data) => freeze(data)) : freeze(result);
    }
    unwrap() {
        return this._def.innerType;
    }
}
exports.ZodReadonly = ZodReadonly;
ZodReadonly.create = (type, params) => {
    return new ZodReadonly({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodReadonly,
        ...processCreateParams(params),
    });
};
////////////////////////////////////////
////////////////////////////////////////
//////////                    //////////
//////////      z.custom      //////////
//////////                    //////////
////////////////////////////////////////
////////////////////////////////////////
function cleanParams(params, data) {
    const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
    const p2 = typeof p === "string" ? { message: p } : p;
    return p2;
}
function custom(check, _params = {}, 
/**
 * @deprecated
 *
 * Pass `fatal` into the params object instead:
 *
 * ```ts
 * z.string().custom((val) => val.length > 5, { fatal: false })
 * ```
 *
 */
fatal) {
    if (check)
        return ZodAny.create().superRefine((data, ctx) => {
            const r = check(data);
            if (r instanceof Promise) {
                return r.then((r) => {
                    if (!r) {
                        const params = cleanParams(_params, data);
                        const _fatal = params.fatal ?? fatal ?? true;
                        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
                    }
                });
            }
            if (!r) {
                const params = cleanParams(_params, data);
                const _fatal = params.fatal ?? fatal ?? true;
                ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
            }
            return;
        });
    return ZodAny.create();
}
exports.late = {
    object: ZodObject.lazycreate,
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind) {
    ZodFirstPartyTypeKind["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (exports.ZodFirstPartyTypeKind = ZodFirstPartyTypeKind = {}));
// requires TS 4.4+
class Class {
    constructor(..._) { }
}
const instanceOfType = (
// const instanceOfType = <T extends new (...args: any[]) => any>(
cls, params = {
    message: `Input not instance of ${cls.name}`,
}) => custom((data) => data instanceof cls, params);
exports["instanceof"] = instanceOfType;
const stringType = ZodString.create;
exports.string = stringType;
const numberType = ZodNumber.create;
exports.number = numberType;
const nanType = ZodNaN.create;
exports.nan = nanType;
const bigIntType = ZodBigInt.create;
exports.bigint = bigIntType;
const booleanType = ZodBoolean.create;
exports.boolean = booleanType;
const dateType = ZodDate.create;
exports.date = dateType;
const symbolType = ZodSymbol.create;
exports.symbol = symbolType;
const undefinedType = ZodUndefined.create;
exports.undefined = undefinedType;
const nullType = ZodNull.create;
exports["null"] = nullType;
const anyType = ZodAny.create;
exports.any = anyType;
const unknownType = ZodUnknown.create;
exports.unknown = unknownType;
const neverType = ZodNever.create;
exports.never = neverType;
const voidType = ZodVoid.create;
exports["void"] = voidType;
const arrayType = ZodArray.create;
exports.array = arrayType;
const objectType = ZodObject.create;
exports.object = objectType;
const strictObjectType = ZodObject.strictCreate;
exports.strictObject = strictObjectType;
const unionType = ZodUnion.create;
exports.union = unionType;
const discriminatedUnionType = ZodDiscriminatedUnion.create;
exports.discriminatedUnion = discriminatedUnionType;
const intersectionType = ZodIntersection.create;
exports.intersection = intersectionType;
const tupleType = ZodTuple.create;
exports.tuple = tupleType;
const recordType = ZodRecord.create;
exports.record = recordType;
const mapType = ZodMap.create;
exports.map = mapType;
const setType = ZodSet.create;
exports.set = setType;
const functionType = ZodFunction.create;
exports["function"] = functionType;
const lazyType = ZodLazy.create;
exports.lazy = lazyType;
const literalType = ZodLiteral.create;
exports.literal = literalType;
const enumType = ZodEnum.create;
exports["enum"] = enumType;
const nativeEnumType = ZodNativeEnum.create;
exports.nativeEnum = nativeEnumType;
const promiseType = ZodPromise.create;
exports.promise = promiseType;
const effectsType = ZodEffects.create;
exports.effect = effectsType;
exports.transformer = effectsType;
const optionalType = ZodOptional.create;
exports.optional = optionalType;
const nullableType = ZodNullable.create;
exports.nullable = nullableType;
const preprocessType = ZodEffects.createWithPreprocess;
exports.preprocess = preprocessType;
const pipelineType = ZodPipeline.create;
exports.pipeline = pipelineType;
const ostring = () => stringType().optional();
exports.ostring = ostring;
const onumber = () => numberType().optional();
exports.onumber = onumber;
const oboolean = () => booleanType().optional();
exports.oboolean = oboolean;
exports.coerce = {
    string: ((arg) => ZodString.create({ ...arg, coerce: true })),
    number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
    boolean: ((arg) => ZodBoolean.create({
        ...arg,
        coerce: true,
    })),
    bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
    date: ((arg) => ZodDate.create({ ...arg, coerce: true })),
};
exports.NEVER = parseUtil_js_1.INVALID;


/***/ }),

/***/ 686:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseIntersectionDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const isJsonSchema7AllOfType = (type) => {
    if ("type" in type && type.type === "string")
        return false;
    return "allOf" in type;
};
function parseIntersectionDef(def, refs) {
    const allOf = [
        (0, parseDef_js_1.parseDef)(def.left._def, {
            ...refs,
            currentPath: [...refs.currentPath, "allOf", "0"],
        }),
        (0, parseDef_js_1.parseDef)(def.right._def, {
            ...refs,
            currentPath: [...refs.currentPath, "allOf", "1"],
        }),
    ].filter((x) => !!x);
    let unevaluatedProperties = refs.target === "jsonSchema2019-09"
        ? { unevaluatedProperties: false }
        : undefined;
    const mergedAllOf = [];
    // If either of the schemas is an allOf, merge them into a single allOf
    allOf.forEach((schema) => {
        if (isJsonSchema7AllOfType(schema)) {
            mergedAllOf.push(...schema.allOf);
            if (schema.unevaluatedProperties === undefined) {
                // If one of the schemas has no unevaluatedProperties set,
                // the merged schema should also have no unevaluatedProperties set
                unevaluatedProperties = undefined;
            }
        }
        else {
            let nestedSchema = schema;
            if ("additionalProperties" in schema &&
                schema.additionalProperties === false) {
                const { additionalProperties, ...rest } = schema;
                nestedSchema = rest;
            }
            else {
                // As soon as one of the schemas has additionalProperties set not to false, we allow unevaluatedProperties
                unevaluatedProperties = undefined;
            }
            mergedAllOf.push(nestedSchema);
        }
    });
    return mergedAllOf.length
        ? {
            allOf: mergedAllOf,
            ...unevaluatedProperties,
        }
        : undefined;
}
exports.parseIntersectionDef = parseIntersectionDef;


/***/ }),

/***/ 726:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.__financeOperationSchemas = exports.__financeSourceSchema = exports.__financeWorkspaceSchema = exports.FinanceDataSaveRequestSchema = exports.FinanceAskRequestSchema = exports.FINANCE_WORKSPACE_LIMITS = exports.FinanceReportLanguageSchema = exports.FINANCE_WIDGET_TYPES = exports.FINANCE_MONITOR_RUN_TIMEOUT_MS = void 0;
exports.financeId = financeId;
exports.createFinanceWorkspace = createFinanceWorkspace;
exports.createFinanceWidget = createFinanceWidget;
exports.createFinanceDashboard = createFinanceDashboard;
exports.financeEvidenceMetric = financeEvidenceMetric;
exports.parseFinanceEvidenceMetric = parseFinanceEvidenceMetric;
exports.validateFinanceWorkspace = validateFinanceWorkspace;
exports.normalizeFinanceDashboard = normalizeFinanceDashboard;
exports.validateFinanceOperation = validateFinanceOperation;
exports.applyFinanceOperations = applyFinanceOperations;
exports.applyFinanceOperation = applyFinanceOperation;
exports.latestFinanceQuote = latestFinanceQuote;
exports.effectiveFinanceWidget = effectiveFinanceWidget;
exports.projectFinanceWidget = projectFinanceWidget;
exports.createFinanceReport = createFinanceReport;
exports.importFinanceCsv = importFinanceCsv;
exports.financeCsvCell = financeCsvCell;
exports.exportFinanceCsv = exportFinanceCsv;
const zod_1 = __webpack_require__(7552);
const finance_analysts_1 = __webpack_require__(9544);
/** Shared service and MCP transport bound; a transport must outlive the service's terminal receipt. */
exports.FINANCE_MONITOR_RUN_TIMEOUT_MS = 180000;
/** Finance is a local document domain. Quotes enter only through explicit data import. */
const id = zod_1.z.string().min(1).max(200);
const text = zod_1.z.string().max(20000);
const currency = zod_1.z.string().regex(/^[A-Z]{3}$/);
const number = zod_1.z.number().finite().min(-1e15).max(1e15);
const date = zod_1.z.string().datetime({ offset: true });
const observationDate = zod_1.z.union([date, zod_1.z.string().date()]);
exports.FINANCE_WIDGET_TYPES = ["watchlist", "holdings", "comparison", "chart", "allocation", "notes", "sources", "events"];
const AssetSchema = zod_1.z.object({
    id, symbol: zod_1.z.string().min(1).max(80), name: zod_1.z.string().min(1).max(300),
    exchange: zod_1.z.string().max(80), currency,
    kind: zod_1.z.enum(["stock", "etf", "fund", "bond", "crypto", "commodity", "other"]),
}).strict();
const HoldingSchema = zod_1.z.object({ id, assetId: id, quantity: number.nonnegative(), averageCost: number.nonnegative().nullable(), currency, sourceId: id }).strict();
const QuoteSchema = zod_1.z.object({ assetId: id, price: number.nonnegative(), currency, asOf: observationDate, sourceId: id, priceBasis: zod_1.z.enum(["price", "total_return"]) }).strict();
const SourceSchema = zod_1.z.object({
    id, name: zod_1.z.string().min(1).max(300), kind: zod_1.z.enum(["csv", "manual", "provider"]),
    status: zod_1.z.enum(["connected", "imported", "unconnected", "error"]),
    asOf: observationDate.nullable(), retrievedAt: date, url: zod_1.z.string().max(2000).url().refine(value => /^https?:\/\//i.test(value), "Only HTTP(S) source URLs are supported").nullable(),
    note: text,
}).strict();
exports.__financeSourceSchema = SourceSchema;
const WidgetSchema = zod_1.z.object({
    id, type: zod_1.z.enum(exports.FINANCE_WIDGET_TYPES), title: zod_1.z.string().min(1).max(300),
    assetIds: zod_1.z.array(id).max(10000), metric: zod_1.z.string().max(200),
    chartType: zod_1.z.enum(["line", "bar", "table"]), width: zod_1.z.enum(["half", "full"]),
    period: zod_1.z.enum(["1M", "3M", "1Y", "5Y", "all"]), notes: text,
    periodMode: zod_1.z.enum(["inherit", "pinned"]).default("inherit"), hidden: zod_1.z.boolean().default(false),
    priceBasis: zod_1.z.enum(["price", "total_return"]), cashFlowMethod: zod_1.z.enum(["none", "twr", "mwr"]),
}).strict();
const DashboardSchema = zod_1.z.object({ id, name: zod_1.z.string().min(1).max(300), period: zod_1.z.enum(["1M", "3M", "1Y", "5Y", "all"]).default("1Y"), widgets: zod_1.z.array(WidgetSchema).max(8000) }).strict();
const ProjectionSchema = zod_1.z.object({
    columns: zod_1.z.array(zod_1.z.string().max(300)).max(100),
    rows: zod_1.z.array(zod_1.z.array(zod_1.z.union([text, number, zod_1.z.null()])).max(100)).max(10000),
    status: zod_1.z.enum(["ready", "partial", "empty", "unsupported"]), warnings: zod_1.z.array(text).max(100),
    asOf: observationDate.nullable(), sourceIds: zod_1.z.array(id).max(10000),
}).strict();
exports.FinanceReportLanguageSchema = zod_1.z.string().min(2).max(80).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).refine(value => { try {
    return Intl.getCanonicalLocales(value).length === 1;
}
catch {
    return false;
} }, "Invalid report language");
const ReportPresentationSchema = zod_1.z.enum(["narrative", "chart", "comparison", "supporting"]);
const SectionSchema = zod_1.z.object({ id, title: zod_1.z.string().min(1).max(300), kind: zod_1.z.enum(["summary", "widget", "narrative", "sources"]), presentation: ReportPresentationSchema.optional(), narrative: text, widget: WidgetSchema.nullable(), projection: ProjectionSchema.nullable() }).strict();
const ReportSchema = zod_1.z.object({ id, language: exports.FinanceReportLanguageSchema.optional(), title: zod_1.z.string().min(1).max(300), createdAt: date, sourceRevision: zod_1.z.number().int().nonnegative(), reviewPending: zod_1.z.boolean(), sections: zod_1.z.array(SectionSchema).max(100), dashboardSnapshot: DashboardSchema.nullable().default(null), parentReportId: id.nullable().default(null) }).strict();
const MonitorSchema = zod_1.z.object({
    id, name: zod_1.z.string().min(1).max(300), query: text, assetIds: zod_1.z.array(id).max(10000),
    status: zod_1.z.enum(["draft", "active", "paused", "unsupported", "error"]),
    lastCheckedAt: date.nullable(), nextCheckAt: date.nullable(), note: text,
    condition: zod_1.z.enum(["price_above", "price_below", "price_change_pct"]).optional(), assetId: id.optional(), threshold: number.optional(),
    automationId: id.optional(),
    executionAvailability: zod_1.z.literal("app-running").optional(), scheduleHuman: zod_1.z.string().max(300).optional(),
}).strict();
exports.FINANCE_WORKSPACE_LIMITS = { reports: 200, sources: 1000 };
const WorkspaceSchema = zod_1.z.object({
    schemaVersion: zod_1.z.literal(1), ownerScope: id.nullable().default(null), revision: zod_1.z.number().int().nonnegative(), activeDashboardId: id.nullable(),
    watchlist: zod_1.z.array(AssetSchema).max(10000), holdings: zod_1.z.array(HoldingSchema).max(10000),
    quotes: zod_1.z.array(QuoteSchema).max(20000), dashboards: zod_1.z.array(DashboardSchema).max(100),
    reports: zod_1.z.array(ReportSchema).max(exports.FINANCE_WORKSPACE_LIMITS.reports), sources: zod_1.z.array(SourceSchema).max(exports.FINANCE_WORKSPACE_LIMITS.sources), monitors: zod_1.z.array(MonitorSchema).max(1000),
}).strict();
exports.__financeWorkspaceSchema = WorkspaceSchema;
exports.FinanceAskRequestSchema = zod_1.z.object({
    request: zod_1.z.string().min(1).max(20000).refine(value => !!value.trim()), screenContext: zod_1.z.string().max(2000),
    baseRevision: zod_1.z.number().int().nonnegative(), requestId: id.optional(),
    selectedAssetIds: zod_1.z.array(id).max(8).refine(items => new Set(items).size === items.length).optional(),
    analystRefs: zod_1.z.array(finance_analysts_1.FinanceAnalystRefSchema).max(3).refine(items => new Set(items.map(item => item.id)).size === items.length).optional(),
    analystAuthoring: zod_1.z.boolean().optional(), analystDraft: finance_analysts_1.FinanceAnalystDraftSchema.optional(),
    analystHistory: zod_1.z.array(zod_1.z.object({ role: zod_1.z.enum(['user', 'assistant']), content: zod_1.z.string().max(20000) }).strict()).max(6).optional(),
}).strict().refine(value => !value.analystDraft || value.analystAuthoring === true)
    .refine(value => !value.analystHistory || value.analystAuthoring === true)
    .refine(value => !value.analystAuthoring || !value.analystRefs?.length)
    .refine(value => !value.analystAuthoring || !value.selectedAssetIds?.length);
/** An existing report is an explicit CAS append target, never an implicit new report. */
exports.FinanceDataSaveRequestSchema = zod_1.z.object({
    query: zod_1.z.string().max(2000), assetIds: zod_1.z.array(id).max(10), metrics: zod_1.z.array(zod_1.z.string().min(1).max(80)).min(1).max(10), period: zod_1.z.string().min(1).max(80),
    expectedRevision: zod_1.z.number().int().nonnegative().optional(), mode: zod_1.z.enum(["sources", "report"]), title: zod_1.z.string().min(1).max(300).optional(), reportId: id.refine(value => !!value.trim()).optional(),
}).strict().refine(value => value.reportId === undefined || (value.mode === "report" && value.expectedRevision !== undefined), "An existing report requires report mode and expectedRevision");
function financeId(prefix = "finance") {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
}
function createFinanceWorkspace() {
    return { schemaVersion: 1, ownerScope: null, revision: 0, activeDashboardId: "finance-dashboard", watchlist: [], holdings: [], quotes: [], dashboards: [DashboardSchema.parse({ id: "finance-dashboard", name: "Agentlas Finance", widgets: [] })], reports: [], sources: [], monitors: [] };
}
const widgetTitles = { watchlist: "Watchlist", holdings: "Holdings", comparison: "Compare", chart: "Chart", allocation: "Allocation", notes: "Notes", sources: "Sources", events: "Events" };
function createFinanceWidget(type, title = widgetTitles[type]) {
    return WidgetSchema.parse({ id: financeId("widget"), type, title, assetIds: [], metric: "price", chartType: type === "allocation" ? "bar" : "table", width: "half", period: "1Y", notes: "", priceBasis: "price", cashFlowMethod: "none" });
}
function createFinanceDashboard(name = "My dashboard", widgets = []) {
    return DashboardSchema.parse({ id: financeId("dashboard"), name, widgets });
}
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`finance_duplicate_id:${label}`);
}
/** Reserved metric encoding; only an existing saved projection can resolve its evidence. */
function financeEvidenceMetric(reportId, sectionId) {
    try {
        for (const value of [reportId, sectionId]) {
            id.parse(value);
            if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value))
                throw new Error();
        }
        const metric = `saved:${encodeURIComponent(reportId)}:${encodeURIComponent(sectionId)}`;
        if (metric.length > 200)
            throw new Error();
        return metric;
    }
    catch {
        throw new Error("finance_evidence_metric_invalid");
    }
}
function parseFinanceEvidenceMetric(metric) {
    if (!metric.startsWith("saved:"))
        return null;
    try {
        const parts = metric.slice(6).split(":");
        if (parts.length !== 2)
            throw new Error();
        const reportId = decodeURIComponent(parts[0]), sectionId = decodeURIComponent(parts[1]);
        if (financeEvidenceMetric(reportId, sectionId) !== metric)
            throw new Error();
        return { reportId, sectionId };
    }
    catch {
        throw new Error("finance_evidence_metric_invalid");
    }
}
function evidenceProjection(ws, ref) {
    return ws.reports.find(report => report.id === ref.reportId)?.sections.find(section => section.id === ref.sectionId)?.projection ?? null;
}
function validateFinanceWorkspace(value) {
    const ws = WorkspaceSchema.parse(value);
    unique(ws.watchlist.map(x => x.id), "asset");
    unique(ws.holdings.map(x => x.id), "holding");
    unique(ws.dashboards.map(x => x.id), "dashboard");
    unique(ws.reports.map(x => x.id), "report");
    unique(ws.sources.map(x => x.id), "source");
    unique(ws.monitors.map(x => x.id), "monitor");
    const assets = new Set(ws.watchlist.map(x => x.id));
    const sources = new Set(ws.sources.map(x => x.id));
    if (ws.activeDashboardId && !ws.dashboards.some(x => x.id === ws.activeDashboardId))
        throw new Error("finance_dashboard_not_found");
    for (const dashboard of ws.dashboards) {
        unique(dashboard.widgets.map(x => x.id), "widget");
        for (const widget of dashboard.widgets) {
            unique(widget.assetIds, "widget_asset");
            if (widget.assetIds.some(assetId => !assets.has(assetId)))
                throw new Error("finance_widget_asset_reference");
            const ref = parseFinanceEvidenceMetric(widget.metric);
            if (ref && !evidenceProjection(ws, ref))
                throw new Error("finance_evidence_reference_invalid");
        }
    }
    for (const monitor of ws.monitors) {
        if (monitor.assetIds.some(assetId => !assets.has(assetId)) || monitor.assetId && !assets.has(monitor.assetId))
            throw new Error("finance_monitor_asset_reference");
    }
    for (const report of ws.reports) {
        unique(report.sections.map(x => x.id), "section");
        for (const section of report.sections)
            if (section.projection?.rows.some(row => row.length !== section.projection.columns.length))
                throw new Error("finance_projection_shape");
    }
    for (const holding of ws.holdings) {
        if (!assets.has(holding.assetId) || !sources.has(holding.sourceId))
            throw new Error("finance_holding_reference");
        if (ws.watchlist.find(x => x.id === holding.assetId)?.currency !== holding.currency)
            throw new Error("finance_holding_currency_mismatch");
    }
    for (const quote of ws.quotes) {
        if (!assets.has(quote.assetId) || !sources.has(quote.sourceId))
            throw new Error("finance_quote_reference");
        if (ws.watchlist.find(x => x.id === quote.assetId)?.currency !== quote.currency)
            throw new Error("finance_quote_currency_mismatch");
    }
    return ws;
}
/** One live canvas; historical report and archive snapshots stay literal. */
function normalizeFinanceDashboard(value, preferredId) {
    const ws = validateFinanceWorkspace(value);
    if (!ws.dashboards.length) {
        const dashboard = createFinanceWorkspace().dashboards[0];
        return { ...ws, dashboards: [dashboard], activeDashboardId: dashboard.id };
    }
    const preferred = ws.dashboards.find(d => d.id === (preferredId ?? ws.activeDashboardId)) ?? ws.dashboards[0];
    const primary = preferred.widgets.length ? preferred : ws.dashboards.find(d => d.widgets.length) ?? preferred;
    if (ws.dashboards.length === 1)
        return { ...ws, activeDashboardId: primary.id };
    const widgets = [];
    const used = new Map();
    for (const dashboard of [primary, ...ws.dashboards.filter(d => d.id !== primary.id)])
        for (const original of dashboard.widgets) {
            const widget = { ...original, assetIds: [...original.assetIds] };
            if (dashboard.id !== primary.id && widget.type === "chart" && widget.periodMode !== "pinned" && dashboard.period !== primary.period) {
                widget.period = dashboard.period;
                widget.periodMode = "pinned";
            }
            const collision = used.get(widget.id);
            if (collision && JSON.stringify(collision) === JSON.stringify(widget))
                continue;
            if (collision) {
                const base = widget.id.slice(0, 160);
                let suffix = widgets.length;
                do {
                    widget.id = `${base}-merged-${suffix++}`;
                } while (used.has(widget.id));
            }
            used.set(widget.id, widget);
            widgets.push(widget);
        }
    if (widgets.length > 8000)
        throw new Error("finance_widget_capacity");
    return { ...ws, dashboards: [{ ...primary, widgets }], activeDashboardId: primary.id };
}
const operationSchemas = {
    "watchlist.add": zod_1.z.object({ type: zod_1.z.literal("watchlist.add"), asset: AssetSchema }).strict(),
    "watchlist.remove": zod_1.z.object({ type: zod_1.z.literal("watchlist.remove"), assetId: id }).strict(),
    "holdings.import": zod_1.z.object({ type: zod_1.z.literal("holdings.import"), assets: zod_1.z.array(AssetSchema).max(10000), holdings: zod_1.z.array(HoldingSchema).max(10000), quotes: zod_1.z.array(QuoteSchema).max(20000).optional(), sources: zod_1.z.array(SourceSchema).max(1000).optional() }).strict(),
    "quotes.import": zod_1.z.object({ type: zod_1.z.literal("quotes.import"), quotes: zod_1.z.array(QuoteSchema).max(20000) }).strict(),
    "dashboard.add": zod_1.z.object({ type: zod_1.z.literal("dashboard.add"), dashboard: DashboardSchema }).strict(),
    "dashboard.rename": zod_1.z.object({ type: zod_1.z.literal("dashboard.rename"), dashboardId: id, name: zod_1.z.string().min(1).max(300) }).strict(),
    "dashboard.update": zod_1.z.object({ type: zod_1.z.literal("dashboard.update"), dashboardId: id, patch: zod_1.z.object({ name: zod_1.z.string().min(1).max(300).optional(), period: zod_1.z.enum(["1M", "3M", "1Y", "5Y", "all"]).optional() }).strict() }).strict(),
    "dashboard.remove": zod_1.z.object({ type: zod_1.z.literal("dashboard.remove"), dashboardId: id }).strict(),
    "dashboard.select": zod_1.z.object({ type: zod_1.z.literal("dashboard.select"), dashboardId: id }).strict(),
    "widget.add": zod_1.z.object({ type: zod_1.z.literal("widget.add"), dashboardId: id, widget: WidgetSchema }).strict(),
    "widget.update": zod_1.z.object({ type: zod_1.z.literal("widget.update"), dashboardId: id, widgetId: id, patch: WidgetSchema.omit({ id: true }).partial().strict() }).strict(),
    "widget.remove": zod_1.z.object({ type: zod_1.z.literal("widget.remove"), dashboardId: id, widgetId: id }).strict(),
    "widget.move": zod_1.z.object({ type: zod_1.z.literal("widget.move"), dashboardId: id, widgetId: id, index: zod_1.z.number().int().nonnegative() }).strict(),
    "report.add": zod_1.z.object({ type: zod_1.z.literal("report.add"), report: ReportSchema }).strict(),
    "report.update": zod_1.z.object({ type: zod_1.z.literal("report.update"), reportId: id, patch: zod_1.z.object({ title: zod_1.z.string().min(1).max(300).optional(), reviewPending: zod_1.z.boolean().optional(), language: exports.FinanceReportLanguageSchema.optional() }).strict() }).strict(),
    "report.remove": zod_1.z.object({ type: zod_1.z.literal("report.remove"), reportId: id }).strict(),
    "report.refresh": zod_1.z.object({ type: zod_1.z.literal("report.refresh"), reportId: id }).strict(),
    "report.section.update": zod_1.z.object({ type: zod_1.z.literal("report.section.update"), reportId: id, sectionId: id, patch: zod_1.z.object({ title: zod_1.z.string().min(1).max(300).optional(), narrative: text.optional(), presentation: ReportPresentationSchema.optional() }).strict() }).strict(),
    "report.section.remove": zod_1.z.object({ type: zod_1.z.literal("report.section.remove"), reportId: id, sectionId: id }).strict(),
    "report.section.move": zod_1.z.object({ type: zod_1.z.literal("report.section.move"), reportId: id, sectionId: id, index: zod_1.z.number().int().nonnegative() }).strict(),
    "source.upsert": zod_1.z.object({ type: zod_1.z.literal("source.upsert"), source: SourceSchema }).strict(),
    "monitor.upsert": zod_1.z.object({ type: zod_1.z.literal("monitor.upsert"), monitor: MonitorSchema }).strict(),
    "monitor.remove": zod_1.z.object({ type: zod_1.z.literal("monitor.remove"), monitorId: id }).strict(),
};
exports.__financeOperationSchemas = operationSchemas;
function validateFinanceOperation(value) {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || !Object.prototype.hasOwnProperty.call(operationSchemas, value.type))
        throw new Error("finance_invalid_operation");
    return operationSchemas[value.type].parse(value);
}
function requireItem(items, itemId) {
    const item = items.find(x => x.id === itemId);
    if (!item)
        throw new Error("finance_item_not_found");
    return item;
}
function upsert(items, item) {
    const index = items.findIndex(x => x.id === item.id);
    if (index < 0)
        items.push(item);
    else
        items[index] = item;
}
function move(items, itemId, index) {
    if (index >= items.length)
        throw new Error("finance_invalid_position");
    const item = requireItem(items, itemId);
    items.splice(items.indexOf(item), 1);
    items.splice(index, 0, item);
}
function mergeQuotes(ws, quotes) {
    for (const quote of quotes) {
        const index = ws.quotes.findIndex(x => x.assetId === quote.assetId && x.asOf === quote.asOf && x.priceBasis === quote.priceBasis && x.sourceId === quote.sourceId);
        if (index < 0)
            ws.quotes.push(quote);
        else
            ws.quotes[index] = quote;
    }
}
function applyFinanceOperations(workspace, operations) {
    if (!operations.length || operations.length > 100)
        throw new Error("finance_invalid_batch_size");
    const next = validateFinanceWorkspace(workspace); // Zod produces a detached copy.
    for (const raw of operations) {
        const op = validateFinanceOperation(raw);
        switch (op.type) {
            case "watchlist.add":
                upsert(next.watchlist, op.asset);
                break;
            case "watchlist.remove":
                requireItem(next.watchlist, op.assetId);
                if (next.holdings.some(x => x.assetId === op.assetId))
                    throw new Error("finance_asset_has_holdings");
                if (next.dashboards.some(x => x.widgets.some(w => w.assetIds.includes(op.assetId))) || next.monitors.some(x => x.assetIds.includes(op.assetId) || x.assetId === op.assetId))
                    throw new Error("finance_asset_is_referenced");
                next.watchlist = next.watchlist.filter(x => x.id !== op.assetId);
                next.quotes = next.quotes.filter(x => x.assetId !== op.assetId);
                break;
            case "holdings.import":
                op.assets.forEach(x => upsert(next.watchlist, x));
                op.holdings.forEach(x => upsert(next.holdings, x));
                op.sources?.forEach(x => upsert(next.sources, x));
                mergeQuotes(next, op.quotes ?? []);
                break;
            case "quotes.import":
                mergeQuotes(next, op.quotes);
                break;
            case "dashboard.add":
                if (next.dashboards.some(x => x.id === op.dashboard.id))
                    throw new Error("finance_duplicate_dashboard");
                next.dashboards.push(op.dashboard);
                next.activeDashboardId = op.dashboard.id;
                break;
            case "dashboard.rename":
                requireItem(next.dashboards, op.dashboardId).name = op.name;
                break;
            case "dashboard.update":
                Object.assign(requireItem(next.dashboards, op.dashboardId), op.patch);
                break;
            case "dashboard.select":
                requireItem(next.dashboards, op.dashboardId);
                next.activeDashboardId = op.dashboardId;
                break;
            case "dashboard.remove":
                requireItem(next.dashboards, op.dashboardId);
                next.dashboards = next.dashboards.filter(x => x.id !== op.dashboardId);
                if (next.activeDashboardId === op.dashboardId)
                    next.activeDashboardId = next.dashboards[0]?.id ?? null;
                break;
            case "widget.add":
                requireItem(next.dashboards, op.dashboardId).widgets.push(op.widget);
                break;
            case "widget.update":
                Object.assign(requireItem(requireItem(next.dashboards, op.dashboardId).widgets, op.widgetId), op.patch);
                break;
            case "widget.remove": {
                const dashboard = requireItem(next.dashboards, op.dashboardId);
                requireItem(dashboard.widgets, op.widgetId);
                dashboard.widgets = dashboard.widgets.filter(x => x.id !== op.widgetId);
                break;
            }
            case "widget.move":
                move(requireItem(next.dashboards, op.dashboardId).widgets, op.widgetId, op.index);
                break;
            case "report.add":
                if (next.reports.some(x => x.id === op.report.id))
                    throw new Error("finance_duplicate_report");
                next.reports.push(op.report);
                break;
            case "report.update":
                Object.assign(requireItem(next.reports, op.reportId), op.patch);
                break;
            case "report.remove":
                requireItem(next.reports, op.reportId);
                next.reports = next.reports.filter(x => x.id !== op.reportId);
                break;
            case "report.refresh": {
                const previous = requireItem(next.reports, op.reportId);
                if (!previous.dashboardSnapshot)
                    throw new Error("finance_report_requires_requery");
                const refreshed = ReportSchema.parse(previous);
                refreshed.id = financeId("report");
                refreshed.parentReportId = previous.id;
                refreshed.createdAt = new Date().toISOString();
                refreshed.sourceRevision = workspace.revision;
                refreshed.reviewPending = true;
                // Saved evidence is already literal; its source report need not remain active.
                // Other widgets recalculate without replacing titles, narratives, order, or pinned periods.
                refreshed.sections = refreshed.sections.map(section => {
                    if (section.widget && parseFinanceEvidenceMetric(section.widget.metric))
                        return section;
                    return { ...section, projection: section.widget ? projectFinanceWidget(next, section.widget) : section.kind === "sources" ? projectFinanceWidget(next, createFinanceWidget("sources")) : section.projection };
                });
                next.reports.push(refreshed);
                break;
            }
            case "report.section.update":
                Object.assign(requireItem(requireItem(next.reports, op.reportId).sections, op.sectionId), op.patch);
                break;
            case "report.section.remove": {
                const report = requireItem(next.reports, op.reportId);
                requireItem(report.sections, op.sectionId);
                report.sections = report.sections.filter(x => x.id !== op.sectionId);
                break;
            }
            case "report.section.move":
                move(requireItem(next.reports, op.reportId).sections, op.sectionId, op.index);
                break;
            case "source.upsert":
                upsert(next.sources, op.source);
                break;
            case "monitor.upsert":
                if (op.monitor.status === "active")
                    throw new Error("finance_monitor_scheduler_unavailable");
                upsert(next.monitors, op.monitor);
                break;
            case "monitor.remove":
                requireItem(next.monitors, op.monitorId);
                next.monitors = next.monitors.filter(x => x.id !== op.monitorId);
                break;
        }
    }
    // Check the final batch state: removing the referencing widget in the same batch is safe.
    for (const dashboard of next.dashboards)
        for (const widget of dashboard.widgets) {
            const ref = parseFinanceEvidenceMetric(widget.metric);
            if (ref && !evidenceProjection(next, ref) && operations.some(op => op.type === "report.remove" && op.reportId === ref.reportId ||
                op.type === "report.section.remove" && op.reportId === ref.reportId && op.sectionId === ref.sectionId)) {
                throw new Error("finance_evidence_is_referenced");
            }
        }
    next.revision = workspace.revision + 1;
    return normalizeFinanceDashboard(validateFinanceWorkspace(next), workspace.activeDashboardId);
}
function applyFinanceOperation(workspace, operation) { return applyFinanceOperations(workspace, [operation]); }
function latestFinanceQuote(ws, assetId, priceBasis = "price") {
    return ws.quotes.filter(x => x.assetId === assetId && x.priceBasis === priceBasis).sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf) || a.sourceId.localeCompare(b.sourceId))[0] ?? null;
}
function effectiveFinanceWidget(dashboard, widget) {
    return { ...widget, assetIds: [...widget.assetIds], period: widget.periodMode === "pinned" ? widget.period : dashboard.period };
}
function projectFinanceWidget(ws, widget) {
    const ref = parseFinanceEvidenceMetric(widget.metric);
    if (ref) {
        const saved = evidenceProjection(ws, ref);
        if (!saved)
            throw new Error("finance_evidence_reference_invalid");
        // Parse creates a detached literal copy, preserving every recorded date, warning, and source ID.
        return ProjectionSchema.parse(saved);
    }
    const projection = { columns: [], rows: [], status: "empty", warnings: [], asOf: null, sourceIds: [] };
    const selected = ws.watchlist.filter(x => !widget.assetIds.length || widget.assetIds.includes(x.id));
    const quotes = selected.map(x => latestFinanceQuote(ws, x.id, widget.priceBasis)).filter((x) => !!x);
    for (const quote of quotes) {
        if (ws.quotes.some(x => x.assetId === quote.assetId && x.asOf === quote.asOf && x.priceBasis === quote.priceBasis && x.price !== quote.price))
            projection.warnings.push(`Conflicting sources for ${quote.assetId} at ${quote.asOf}; selected source ${quote.sourceId}.`);
    }
    projection.sourceIds = [...new Set(quotes.map(x => x.sourceId))];
    // A common timestamp is truthful only when all observations actually share it.
    const times = [...new Set(quotes.map(x => x.asOf))];
    projection.asOf = times.length === 1 ? times[0] : null;
    if (times.length > 1)
        projection.warnings.push("Observations have different timestamps; see each row.");
    if (widget.type === "notes") {
        projection.columns = ["Note"];
        projection.rows = widget.notes ? [[widget.notes]] : [];
        projection.sourceIds = [];
        projection.asOf = null;
        projection.warnings = [];
    }
    else if (widget.type === "sources") {
        projection.columns = ["Source", "Status", "Observed at", "Retrieved at"];
        projection.rows = ws.sources.map(x => [x.name, x.status, x.asOf, x.retrievedAt]);
        projection.sourceIds = ws.sources.map(x => x.id);
        const sourceTimes = [...new Set(ws.sources.map(x => x.asOf))];
        projection.asOf = sourceTimes.length === 1 ? sourceTimes[0] : null;
        projection.warnings = sourceTimes.length > 1 ? ["Sources have different or missing observation dates; see each row."] : [];
    }
    else if (widget.type === "events") {
        projection.status = "unsupported";
        projection.sourceIds = [];
        projection.asOf = null;
        projection.warnings = ["No event provider is connected."];
        return projection;
    }
    else if (widget.cashFlowMethod !== "none") {
        projection.status = "unsupported";
        projection.warnings.push("TWR/MWR requires dated cash flows and valuation history; a quote snapshot cannot calculate it.");
        return projection;
    }
    else if (widget.type === "chart") {
        if (widget.metric !== "price") {
            projection.status = "unsupported";
            projection.warnings.push(`Metric '${widget.metric}' has no connected historical data.`);
            return projection;
        }
        projection.columns = ["Observed at", "Symbol", "Currency", "Price", "Source"];
        const matching = ws.quotes.filter(x => selected.some(a => a.id === x.assetId) && x.priceBasis === widget.priceBasis);
        const end = Math.max(...matching.map(x => Date.parse(x.asOf)));
        const days = { "1M": 31, "3M": 93, "1Y": 366, "5Y": 1830, all: Infinity }[widget.period];
        const start = end - days * 86400000;
        const dated = matching.filter(x => Date.parse(x.asOf) >= start).sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf) || a.assetId.localeCompare(b.assetId) || a.sourceId.localeCompare(b.sourceId));
        const seen = new Set();
        for (const quote of dated) {
            const key = `${quote.assetId}:${quote.asOf}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const asset = selected.find(x => x.id === quote.assetId);
            projection.rows.push([quote.asOf, asset.symbol, quote.currency, quote.price, ws.sources.find(x => x.id === quote.sourceId)?.name ?? null]);
        }
        projection.sourceIds = [...new Set(dated.map(x => x.sourceId))];
        projection.asOf = dated[dated.length - 1]?.asOf ?? null;
        if (projection.rows.length)
            projection.warnings.push("Range ends at the last imported observation, not current market time. Gaps are not interpolated.");
        if (selected.some(asset => new Set(dated.filter(x => x.assetId === asset.id).map(x => x.asOf)).size < 2))
            projection.warnings.push("Some assets have fewer than two observations; do not infer a trend.");
        if (new Set(dated.map(x => x.currency)).size > 1)
            projection.warnings.push("Different currencies must use separate series/scales; no implicit FX conversion.");
    }
    else if (widget.type === "holdings" || widget.type === "allocation") {
        if (widget.priceBasis !== "price") {
            projection.status = "unsupported";
            projection.warnings.push("Market value requires an actual price. A total-return index is not a tradable valuation price.");
            return projection;
        }
        projection.columns = ["Asset", "Quantity", "Currency", "Average cost", "Price", "Market value", "Unrealized P&L", "Observed at"];
        for (const holding of ws.holdings.filter(x => selected.some(a => a.id === x.assetId))) {
            const asset = ws.watchlist.find(x => x.id === holding.assetId);
            const quote = latestFinanceQuote(ws, asset.id, "price");
            const price = quote?.currency === holding.currency ? quote.price : null;
            const value = price === null ? null : holding.quantity * price;
            const pnl = price === null || holding.averageCost === null ? null : holding.quantity * (price - holding.averageCost);
            projection.rows.push([asset.symbol, holding.quantity, holding.currency, holding.averageCost, price, value, pnl, quote?.asOf ?? null]);
            projection.sourceIds.push(holding.sourceId);
            if (quote)
                projection.sourceIds.push(quote.sourceId);
        }
        projection.warnings.push("Values remain in each holding's currency; no implicit FX conversion or cross-currency total.");
        if (widget.type === "allocation")
            projection.warnings.push("This is direct holding exposure. ETF look-through and portfolio weights are unavailable without complete compatible holdings and FX data.");
        if (projection.rows.some(x => x[4] === null))
            projection.warnings.push("Some holdings have no compatible imported price. Missing values are not zero.");
    }
    else {
        projection.columns = ["Symbol", "Name", "Exchange", "Currency", "Price", "Observed at", "Source"];
        projection.rows = selected.map(asset => {
            const quote = latestFinanceQuote(ws, asset.id, widget.priceBasis);
            return [asset.symbol, asset.name, asset.exchange, asset.currency, quote?.currency === asset.currency ? quote.price : null, quote?.asOf ?? null, quote ? ws.sources.find(x => x.id === quote.sourceId)?.name ?? null : null];
        });
        if (widget.metric !== "price")
            projection.warnings.push(`Metric '${widget.metric}' has no connected data; only available price snapshots are shown.`);
        if (projection.rows.some(x => x[4] === null))
            projection.warnings.push("Some assets have no compatible imported quote. Missing values are not zero.");
    }
    projection.sourceIds = [...new Set(projection.sourceIds)];
    projection.status = !projection.rows.length ? "empty" : projection.warnings.length ? "partial" : "ready";
    return projection;
}
function createFinanceReport(ws, dashboard, title = dashboard.name) {
    const report = { id: financeId("report"), title, createdAt: new Date().toISOString(), sourceRevision: ws.revision, reviewPending: true, dashboardSnapshot: DashboardSchema.parse(dashboard), parentReportId: null, sections: [
            { id: financeId("section"), title: "Summary", kind: "summary", narrative: "", widget: null, projection: null },
            ...dashboard.widgets.filter(widget => !widget.hidden).map(widget => { const effective = effectiveFinanceWidget(dashboard, widget); return { id: financeId("section"), title: widget.title, kind: "widget", narrative: "", widget: WidgetSchema.parse(effective), projection: projectFinanceWidget(ws, effective) }; }),
            { id: financeId("section"), title: "Sources and limitations", kind: "sources", narrative: "Sources and observation dates are listed below. Check missing values and source limitations before sharing.", widget: null, projection: projectFinanceWidget(ws, createFinanceWidget("sources")) },
        ] };
    return ReportSchema.parse(report);
}
/** RFC 4180 quoting, BOM, CRLF, and quoted newlines. Reject malformed files rather than guessing. */
function csvRecords(input) {
    if (input.length > 2_000_000)
        throw new Error("finance_csv_too_large");
    const source = input.replace(/^\uFEFF/, "");
    const records = [];
    let row = [];
    let field = "";
    let quoted = false;
    let closed = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
            if (char === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    quoted = false;
                    closed = true;
                }
            }
            else
                field += char;
        }
        else if (char === '"') {
            if (field || closed)
                throw new Error("finance_csv_invalid_quote");
            quoted = true;
        }
        else if (char === ",") {
            row.push(field);
            field = "";
            closed = false;
        }
        else if (char === "\n" || char === "\r") {
            if (char === "\r" && source[i + 1] === "\n")
                i++;
            row.push(field);
            if (row.some(x => x.trim()))
                records.push(row);
            row = [];
            field = "";
            closed = false;
            if (records.length > 10001)
                throw new Error("finance_csv_too_many_rows");
        }
        else {
            if (closed && !/\s/.test(char))
                throw new Error("finance_csv_trailing_quote_data");
            if (!closed)
                field += char;
        }
    }
    if (quoted)
        throw new Error("finance_csv_unclosed_quote");
    row.push(field);
    if (row.some(x => x.trim()))
        records.push(row);
    if (records.length > 10001)
        throw new Error("finance_csv_too_many_rows");
    return records;
}
function stableAssetId(exchange, symbol, ccy) { return `asset:${encodeURIComponent(exchange)}:${encodeURIComponent(symbol)}:${ccy}`; }
function importFinanceCsv(input, options = {}) {
    const result = { assets: [], holdings: [], quotes: [], sources: [], errors: [], warnings: [], rowCount: 0 };
    let records;
    try {
        records = csvRecords(input);
    }
    catch (error) {
        result.errors.push(error instanceof Error ? error.message : "finance_csv_invalid");
        return result;
    }
    if (!records.length) {
        result.errors.push("CSV is empty.");
        return result;
    }
    if (records.length === 1) {
        result.errors.push("CSV has headers but no data rows.");
        return result;
    }
    const aliases = { ticker: "symbol", 종목: "symbol", 티커: "symbol", 종목명: "name", 거래소: "exchange", 통화: "currency", 수량: "quantity", 평균단가: "average_cost", cost_basis: "average_cost", averagecost: "average_cost", price: "price", 현재가: "price", asof: "as_of", 기준시각: "as_of", 유형: "kind" };
    const headers = records[0].map(x => { const key = x.trim().toLowerCase().replace(/[ -]/g, "_"); return aliases[key] ?? key; });
    if (new Set(headers).size !== headers.length) {
        result.errors.push("Duplicate CSV columns.");
        return result;
    }
    if (!headers.includes("symbol")) {
        result.errors.push("Required column: symbol.");
        return result;
    }
    const unknown = headers.filter(x => !["symbol", "name", "exchange", "currency", "quantity", "average_cost", "price", "as_of", "kind", "price_basis"].includes(x));
    if (unknown.length)
        result.warnings.push(`Unused columns: ${unknown.join(", ")}`);
    const now = new Date().toISOString();
    const sourceId = financeId("csv");
    const source = { id: sourceId, name: "CSV import", kind: "csv", status: "imported", asOf: null, retrievedAt: now, url: null, note: "User-provided file; values are not independently verified market data." };
    const seen = new Set();
    for (let index = 1; index < records.length; index++) {
        result.rowCount++;
        const row = records[index];
        if (row.length !== headers.length) {
            result.errors.push(`Row ${index + 1}: column count mismatch.`);
            continue;
        }
        const record = Object.create(null);
        headers.forEach((key, i) => { record[key] = row[i].trim(); });
        try {
            const symbol = record.symbol.toUpperCase();
            const ccy = (record.currency || options.defaultCurrency || "").toUpperCase();
            if (!/^[A-Z]{3}$/.test(ccy))
                throw new Error("currency must be an explicit three-letter code");
            const exchange = (record.exchange || "").toUpperCase();
            const assetId = stableAssetId(exchange, symbol, ccy);
            if (seen.has(assetId))
                throw new Error("duplicate asset row; aggregate explicitly before import");
            const asset = AssetSchema.parse({ id: assetId, symbol, name: record.name || symbol, exchange, currency: ccy, kind: record.kind || "other" });
            const parseNumber = (value, label) => {
                if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
                    throw new Error(`${label} must be a nonnegative decimal without separators`);
                return number.nonnegative().parse(Number(value));
            };
            let holding = null;
            let quote = null;
            if (headers.includes("quantity")) {
                if (!record.quantity)
                    throw new Error("quantity is missing, not zero");
                holding = HoldingSchema.parse({ id: `holding:${assetId}`, assetId, quantity: parseNumber(record.quantity, "quantity"), averageCost: record.average_cost ? parseNumber(record.average_cost, "average_cost") : null, currency: ccy, sourceId });
            }
            if (record.price) {
                if (!record.as_of)
                    throw new Error("as_of requires an explicit date or timestamp with timezone when price is supplied");
                const asOf = observationDate.parse(record.as_of);
                quote = QuoteSchema.parse({ assetId, price: parseNumber(record.price, "price"), currency: ccy, asOf, sourceId, priceBasis: record.price_basis || "price" });
            }
            seen.add(assetId);
            result.assets.push(asset);
            if (holding)
                result.holdings.push(holding);
            if (quote)
                result.quotes.push(quote);
        }
        catch (error) {
            result.errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : "invalid values"}`);
        }
    }
    if (result.assets.length)
        result.sources.push(source);
    if (!result.quotes.length && result.assets.length)
        result.warnings.push("No dated quote snapshots were imported. Market values remain missing.");
    if (result.errors.length)
        result.warnings.push("Import is not committed. Resolve errors before applying these rows.");
    return result;
}
/** Escape CSV fields and neutralize spreadsheet formula execution on untrusted text. */
function financeCsvCell(value) {
    if (value === null)
        return "";
    let result = String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(result))
        result = `'${result}`;
    return /[",\r\n]/.test(result) ? `"${result.replace(/"/g, '""')}"` : result;
}
function exportFinanceCsv(value) {
    if ("schemaVersion" in value) {
        const headers = ["symbol", "name", "exchange", "currency", "kind", "quantity", "average_cost", "price", "as_of", "price_basis"];
        const rows = value.watchlist.map(asset => {
            const holding = value.holdings.find(x => x.assetId === asset.id);
            const quote = latestFinanceQuote(value, asset.id);
            return [asset.symbol, asset.name, asset.exchange, asset.currency, asset.kind, holding?.quantity ?? null, holding?.averageCost ?? null, quote?.price ?? null, quote?.asOf ?? null, quote?.priceBasis ?? "price"];
        });
        return [headers, ...rows].map(row => row.map(financeCsvCell).join(",")).join("\r\n");
    }
    return [value.columns, ...value.rows].map(row => row.map(financeCsvCell).join(",")).join("\r\n");
}


/***/ }),

/***/ 802:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));


/***/ }),

/***/ 819:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isAsync = exports.isValid = exports.isDirty = exports.isAborted = exports.OK = exports.DIRTY = exports.INVALID = exports.ParseStatus = exports.EMPTY_PATH = exports.makeIssue = void 0;
exports.addIssueToContext = addIssueToContext;
const errors_js_1 = __webpack_require__(9317);
const en_js_1 = __importDefault(__webpack_require__(5653));
const makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...(issueData.path || [])];
    const fullIssue = {
        ...issueData,
        path: fullPath,
    };
    if (issueData.message !== undefined) {
        return {
            ...issueData,
            path: fullPath,
            message: issueData.message,
        };
    }
    let errorMessage = "";
    const maps = errorMaps
        .filter((m) => !!m)
        .slice()
        .reverse();
    for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return {
        ...issueData,
        path: fullPath,
        message: errorMessage,
    };
};
exports.makeIssue = makeIssue;
exports.EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
    const overrideMap = (0, errors_js_1.getErrorMap)();
    const issue = (0, exports.makeIssue)({
        issueData: issueData,
        data: ctx.data,
        path: ctx.path,
        errorMaps: [
            ctx.common.contextualErrorMap, // contextual error map is first priority
            ctx.schemaErrorMap, // then schema-bound map if available
            overrideMap, // then global override map
            overrideMap === en_js_1.default ? undefined : en_js_1.default, // then global default map
        ].filter((x) => !!x),
    });
    ctx.common.issues.push(issue);
}
class ParseStatus {
    constructor() {
        this.value = "valid";
    }
    dirty() {
        if (this.value === "valid")
            this.value = "dirty";
    }
    abort() {
        if (this.value !== "aborted")
            this.value = "aborted";
    }
    static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
            if (s.status === "aborted")
                return exports.INVALID;
            if (s.status === "dirty")
                status.dirty();
            arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
                key,
                value,
            });
        }
        return ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
            const { key, value } = pair;
            if (key.status === "aborted")
                return exports.INVALID;
            if (value.status === "aborted")
                return exports.INVALID;
            if (key.status === "dirty")
                status.dirty();
            if (value.status === "dirty")
                status.dirty();
            if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
                finalObject[key.value] = value.value;
            }
        }
        return { status: status.value, value: finalObject };
    }
}
exports.ParseStatus = ParseStatus;
exports.INVALID = Object.freeze({
    status: "aborted",
});
const DIRTY = (value) => ({ status: "dirty", value });
exports.DIRTY = DIRTY;
const OK = (value) => ({ status: "valid", value });
exports.OK = OK;
const isAborted = (x) => x.status === "aborted";
exports.isAborted = isAborted;
const isDirty = (x) => x.status === "dirty";
exports.isDirty = isDirty;
const isValid = (x) => x.status === "valid";
exports.isValid = isValid;
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
exports.isAsync = isAsync;


/***/ }),

/***/ 1076:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getRefs = void 0;
const Options_js_1 = __webpack_require__(2626);
const getRefs = (options) => {
    const _options = (0, Options_js_1.getDefaultOptions)(options);
    const currentPath = _options.name !== undefined
        ? [..._options.basePath, _options.definitionPath, _options.name]
        : _options.basePath;
    return {
        ..._options,
        flags: { hasReferencedOpenAiAnyType: false },
        currentPath: currentPath,
        propertyPath: undefined,
        seen: new Map(Object.entries(_options.definitions).map(([name, def]) => [
            def._def,
            {
                def: def._def,
                path: [..._options.basePath, _options.definitionPath, name],
                // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
                jsonSchema: undefined,
            },
        ])),
    };
};
exports.getRefs = getRefs;


/***/ }),

/***/ 1114:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseNumberDef = void 0;
const errorMessages_js_1 = __webpack_require__(8950);
function parseNumberDef(def, refs) {
    const res = {
        type: "number",
    };
    if (!def.checks)
        return res;
    for (const check of def.checks) {
        switch (check.kind) {
            case "int":
                res.type = "integer";
                (0, errorMessages_js_1.addErrorMessage)(res, "type", check.message, refs);
                break;
            case "min":
                if (refs.target === "jsonSchema7") {
                    if (check.inclusive) {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minimum", check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "exclusiveMinimum", check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMinimum = true;
                    }
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minimum", check.value, check.message, refs);
                }
                break;
            case "max":
                if (refs.target === "jsonSchema7") {
                    if (check.inclusive) {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maximum", check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "exclusiveMaximum", check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMaximum = true;
                    }
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maximum", check.value, check.message, refs);
                }
                break;
            case "multipleOf":
                (0, errorMessages_js_1.setResponseValueAndErrors)(res, "multipleOf", check.value, check.message, refs);
                break;
        }
    }
    return res;
}
exports.parseNumberDef = parseNumberDef;


/***/ }),

/***/ 1854:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseNullableDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const union_js_1 = __webpack_require__(8348);
function parseNullableDef(def, refs) {
    if (["ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodNull"].includes(def.innerType._def.typeName) &&
        (!def.innerType._def.checks || !def.innerType._def.checks.length)) {
        if (refs.target === "openApi3") {
            return {
                type: union_js_1.primitiveMappings[def.innerType._def.typeName],
                nullable: true,
            };
        }
        return {
            type: [
                union_js_1.primitiveMappings[def.innerType._def.typeName],
                "null",
            ],
        };
    }
    if (refs.target === "openApi3") {
        const base = (0, parseDef_js_1.parseDef)(def.innerType._def, {
            ...refs,
            currentPath: [...refs.currentPath],
        });
        if (base && "$ref" in base)
            return { allOf: [base], nullable: true };
        return base && { ...base, nullable: true };
    }
    const base = (0, parseDef_js_1.parseDef)(def.innerType._def, {
        ...refs,
        currentPath: [...refs.currentPath, "anyOf", "0"],
    });
    return base && { anyOf: [base, { type: "null" }] };
}
exports.parseNullableDef = parseNullableDef;


/***/ }),

/***/ 2034:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getParsedType = exports.ZodParsedType = exports.objectUtil = exports.util = void 0;
var util;
(function (util) {
    util.assertEqual = (_) => { };
    function assertIs(_arg) { }
    util.assertIs = assertIs;
    function assertNever(_x) {
        throw new Error();
    }
    util.assertNever = assertNever;
    util.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
            obj[item] = item;
        }
        return obj;
    };
    util.getValidEnumValues = (obj) => {
        const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
            filtered[k] = obj[k];
        }
        return util.objectValues(filtered);
    };
    util.objectValues = (obj) => {
        return util.objectKeys(obj).map(function (e) {
            return obj[e];
        });
    };
    util.objectKeys = typeof Object.keys === "function" // eslint-disable-line ban/ban
        ? (obj) => Object.keys(obj) // eslint-disable-line ban/ban
        : (object) => {
            const keys = [];
            for (const key in object) {
                if (Object.prototype.hasOwnProperty.call(object, key)) {
                    keys.push(key);
                }
            }
            return keys;
        };
    util.find = (arr, checker) => {
        for (const item of arr) {
            if (checker(item))
                return item;
        }
        return undefined;
    };
    util.isInteger = typeof Number.isInteger === "function"
        ? (val) => Number.isInteger(val) // eslint-disable-line ban/ban
        : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
        return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
    }
    util.joinValues = joinValues;
    util.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
            return value.toString();
        }
        return value;
    };
})(util || (exports.util = util = {}));
var objectUtil;
(function (objectUtil) {
    objectUtil.mergeShapes = (first, second) => {
        return {
            ...first,
            ...second, // second overwrites first
        };
    };
})(objectUtil || (exports.objectUtil = objectUtil = {}));
exports.ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set",
]);
const getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
        case "undefined":
            return exports.ZodParsedType.undefined;
        case "string":
            return exports.ZodParsedType.string;
        case "number":
            return Number.isNaN(data) ? exports.ZodParsedType.nan : exports.ZodParsedType.number;
        case "boolean":
            return exports.ZodParsedType.boolean;
        case "function":
            return exports.ZodParsedType.function;
        case "bigint":
            return exports.ZodParsedType.bigint;
        case "symbol":
            return exports.ZodParsedType.symbol;
        case "object":
            if (Array.isArray(data)) {
                return exports.ZodParsedType.array;
            }
            if (data === null) {
                return exports.ZodParsedType.null;
            }
            if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
                return exports.ZodParsedType.promise;
            }
            if (typeof Map !== "undefined" && data instanceof Map) {
                return exports.ZodParsedType.map;
            }
            if (typeof Set !== "undefined" && data instanceof Set) {
                return exports.ZodParsedType.set;
            }
            if (typeof Date !== "undefined" && data instanceof Date) {
                return exports.ZodParsedType.date;
            }
            return exports.ZodParsedType.object;
        default:
            return exports.ZodParsedType.unknown;
    }
};
exports.getParsedType = getParsedType;


/***/ }),

/***/ 2465:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.selectParser = void 0;
const v3_1 = __webpack_require__(9164);
const any_js_1 = __webpack_require__(2909);
const array_js_1 = __webpack_require__(8598);
const bigint_js_1 = __webpack_require__(7236);
const boolean_js_1 = __webpack_require__(8147);
const branded_js_1 = __webpack_require__(6163);
const catch_js_1 = __webpack_require__(6260);
const date_js_1 = __webpack_require__(5187);
const default_js_1 = __webpack_require__(9606);
const effects_js_1 = __webpack_require__(8385);
const enum_js_1 = __webpack_require__(6750);
const intersection_js_1 = __webpack_require__(686);
const literal_js_1 = __webpack_require__(4836);
const map_js_1 = __webpack_require__(9137);
const nativeEnum_js_1 = __webpack_require__(6773);
const never_js_1 = __webpack_require__(3237);
const null_js_1 = __webpack_require__(7294);
const nullable_js_1 = __webpack_require__(1854);
const number_js_1 = __webpack_require__(1114);
const object_js_1 = __webpack_require__(6172);
const optional_js_1 = __webpack_require__(5867);
const pipeline_js_1 = __webpack_require__(9225);
const promise_js_1 = __webpack_require__(3858);
const record_js_1 = __webpack_require__(7054);
const set_js_1 = __webpack_require__(4519);
const string_js_1 = __webpack_require__(3178);
const tuple_js_1 = __webpack_require__(2793);
const undefined_js_1 = __webpack_require__(7987);
const union_js_1 = __webpack_require__(8348);
const unknown_js_1 = __webpack_require__(5973);
const readonly_js_1 = __webpack_require__(9729);
const selectParser = (def, typeName, refs) => {
    switch (typeName) {
        case v3_1.ZodFirstPartyTypeKind.ZodString:
            return (0, string_js_1.parseStringDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodNumber:
            return (0, number_js_1.parseNumberDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodObject:
            return (0, object_js_1.parseObjectDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBigInt:
            return (0, bigint_js_1.parseBigintDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBoolean:
            return (0, boolean_js_1.parseBooleanDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodDate:
            return (0, date_js_1.parseDateDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodUndefined:
            return (0, undefined_js_1.parseUndefinedDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodNull:
            return (0, null_js_1.parseNullDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodArray:
            return (0, array_js_1.parseArrayDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodUnion:
        case v3_1.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
            return (0, union_js_1.parseUnionDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodIntersection:
            return (0, intersection_js_1.parseIntersectionDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodTuple:
            return (0, tuple_js_1.parseTupleDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodRecord:
            return (0, record_js_1.parseRecordDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodLiteral:
            return (0, literal_js_1.parseLiteralDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodEnum:
            return (0, enum_js_1.parseEnumDef)(def);
        case v3_1.ZodFirstPartyTypeKind.ZodNativeEnum:
            return (0, nativeEnum_js_1.parseNativeEnumDef)(def);
        case v3_1.ZodFirstPartyTypeKind.ZodNullable:
            return (0, nullable_js_1.parseNullableDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodOptional:
            return (0, optional_js_1.parseOptionalDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodMap:
            return (0, map_js_1.parseMapDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodSet:
            return (0, set_js_1.parseSetDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodLazy:
            return () => def.getter()._def;
        case v3_1.ZodFirstPartyTypeKind.ZodPromise:
            return (0, promise_js_1.parsePromiseDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodNaN:
        case v3_1.ZodFirstPartyTypeKind.ZodNever:
            return (0, never_js_1.parseNeverDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodEffects:
            return (0, effects_js_1.parseEffectsDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodAny:
            return (0, any_js_1.parseAnyDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodUnknown:
            return (0, unknown_js_1.parseUnknownDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodDefault:
            return (0, default_js_1.parseDefaultDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBranded:
            return (0, branded_js_1.parseBrandedDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodReadonly:
            return (0, readonly_js_1.parseReadonlyDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodCatch:
            return (0, catch_js_1.parseCatchDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodPipeline:
            return (0, pipeline_js_1.parsePipelineDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodFunction:
        case v3_1.ZodFirstPartyTypeKind.ZodVoid:
        case v3_1.ZodFirstPartyTypeKind.ZodSymbol:
            return undefined;
        default:
            return ((_) => undefined)(typeName);
    }
};
exports.selectParser = selectParser;


/***/ }),

/***/ 2626:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getDefaultOptions = exports.defaultOptions = exports.jsonDescription = exports.ignoreOverride = void 0;
exports.ignoreOverride = Symbol("Let zodToJsonSchema decide on which parser to use");
const jsonDescription = (jsonSchema, def) => {
    if (def.description) {
        try {
            return {
                ...jsonSchema,
                ...JSON.parse(def.description),
            };
        }
        catch { }
    }
    return jsonSchema;
};
exports.jsonDescription = jsonDescription;
exports.defaultOptions = {
    name: undefined,
    $refStrategy: "root",
    basePath: ["#"],
    effectStrategy: "input",
    pipeStrategy: "all",
    dateStrategy: "format:date-time",
    mapStrategy: "entries",
    removeAdditionalStrategy: "passthrough",
    allowedAdditionalProperties: true,
    rejectedAdditionalProperties: false,
    definitionPath: "definitions",
    target: "jsonSchema7",
    strictUnions: false,
    definitions: {},
    errorMessages: false,
    markdownDescription: false,
    patternStrategy: "escape",
    applyRegexFlags: false,
    emailStrategy: "format:email",
    base64Strategy: "contentEncoding:base64",
    nameStrategy: "ref",
    openAiAnyTypeName: "OpenAiAnyType"
};
const getDefaultOptions = (options) => (typeof options === "string"
    ? {
        ...exports.defaultOptions,
        name: options,
    }
    : {
        ...exports.defaultOptions,
        ...options,
    });
exports.getDefaultOptions = getDefaultOptions;


/***/ }),

/***/ 2772:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.financePlanningArtifact = financePlanningArtifact;
const finance_1 = __webpack_require__(726);
const PLANNING_COPY = {
    en: { title: 'Financial plan', charts: { cashflow: 'Projected balance', income_goal: 'Monthly income', rebalance: 'Target holding values' }, income: { 'Investment income': 'Investment income', 'Other income': 'Other income', 'Income target': 'Income target' }, tradeTitle: 'Suggested trades', tradeColumns: ['Instrument', 'Action', 'Amount', 'Estimated fee'], tradeActions: { buy: 'Buy', sell: 'Sell', hold: 'Hold' } },
    ko: { title: '자산 계획', charts: { cashflow: '예상 잔액', income_goal: '월 소득', rebalance: '목표 보유 금액' }, income: { 'Investment income': '투자소득', 'Other income': '기타 소득', 'Income target': '소득 목표' }, tradeTitle: '리밸런싱 계획', tradeColumns: ['상품', '구분', '금액', '예상 수수료'], tradeActions: { buy: '매수', sell: '매도', hold: '유지' } },
    ja: { title: '資産計画', charts: { cashflow: '予想残高', income_goal: '月間収入', rebalance: '目標保有額' }, income: { 'Investment income': '投資収入', 'Other income': 'その他の収入', 'Income target': '目標収入' }, tradeTitle: 'リバランス計画', tradeColumns: ['商品', '売買区分', '金額', '予想手数料'], tradeActions: { buy: '買付', sell: '売却', hold: '維持' } },
    zh: { title: '资产规划', charts: { cashflow: '预计余额', income_goal: '月度收入', rebalance: '目标持仓金额' }, income: { 'Investment income': '投资收入', 'Other income': '其他收入', 'Income target': '收入目标' }, tradeTitle: '再平衡计划', tradeColumns: ['产品', '操作', '金额', '预计费用'], tradeActions: { buy: '买入', sell: '卖出', hold: '持有' } },
};
/** Freeze the literal scenario result; source metadata remains supporting rather than reader boilerplate. */
function financePlanningArtifact(result, workspace, presentation = {}) {
    if (presentation.tradeColumns && presentation.tradeColumns.length !== 4)
        throw new Error('finance_planning_display_columns_invalid');
    const language = presentation.language ? finance_1.FinanceReportLanguageSchema.parse(presentation.language) : undefined, base = language?.split('-')[0].toLowerCase(), copy = base && Object.hasOwn(PLANNING_COPY, base) ? PLANNING_COPY[base] : language ? undefined : PLANNING_COPY.en, title = (presentation.title ?? copy?.title ?? 'Financial plan').slice(0, 300), now = new Date().toISOString(), sourceId = (0, finance_1.financeId)('source'), reportId = (0, finance_1.financeId)('report');
    if (!result.charts.length || !result.charts[0].points.length)
        throw new Error('finance_planning_artifact_no_visual');
    const chart = result.charts[0], chartTitle = presentation.chartTitle ?? copy?.charts[result.kind] ?? presentation.title ?? chart.label, widget = (0, finance_1.createFinanceWidget)('chart', chartTitle);
    widget.width = 'full';
    widget.chartType = chart.type;
    widget.metric = `planning:${result.kind}`;
    widget.notes = result.currency;
    const chartLabels = { ...(result.kind === 'income_goal' ? copy?.income : {}), ...presentation.chartLabels };
    const displayRows = chart.points.map(point => [typeof point.x === 'string' && Object.hasOwn(chartLabels, point.x) ? chartLabels[point.x] : point.x, point.y]);
    if (new Set(displayRows.map(row => row[0])).size !== displayRows.length)
        throw new Error('finance_planning_display_labels_ambiguous');
    const sections = [];
    if (presentation.narrative?.trim())
        sections.push({ id: (0, finance_1.financeId)('section'), title, kind: 'summary', presentation: 'narrative', narrative: presentation.narrative.slice(0, 20000), widget: null, projection: null });
    sections.push({ id: (0, finance_1.financeId)('section'), title: chartTitle, kind: 'widget', presentation: 'chart', narrative: '', widget, projection: { columns: ['period', 'value'], rows: displayRows, status: result.status === 'ok' ? 'ready' : 'partial', warnings: [...result.warnings, ...result.errors.map(e => e.code)].slice(0, 100), asOf: result.asOf, sourceIds: [sourceId] } });
    if (result.kind === 'rebalance' && result.status === 'ok' && result.trades.some(t => t.side !== 'hold'))
        sections.push({ id: (0, finance_1.financeId)('section'), title: presentation.tradeTitle?.trim() ? presentation.tradeTitle : copy?.tradeTitle ?? 'Suggested trades', kind: 'widget', presentation: 'comparison', narrative: '', widget: null, projection: { columns: presentation.tradeColumns ?? [...(copy?.tradeColumns ?? ['Instrument', 'Action', 'Amount', 'Estimated fee'])], rows: result.trades.filter(t => t.side !== 'hold').map(t => [t.label, presentation.tradeActions?.[t.side] ?? copy?.tradeActions[t.side] ?? t.side, t.amount, t.estimatedFee]), status: 'ready', warnings: [], asOf: result.asOf, sourceIds: [sourceId] } });
    // Full assumptions and exact decimal results are retained for reproducibility without duplicating charts in normal reading.
    const supporting = JSON.stringify({ inputSha256: result.inputSha256, engineVersion: result.engineVersion, request: result.request, metrics: result.metrics, assumptions: result.assumptions, warnings: result.warnings, errors: result.errors, presentation });
    sections.push({ id: (0, finance_1.financeId)('section'), title: 'Scenario assumptions', kind: 'sources', presentation: 'supporting', narrative: '', widget: null, projection: { columns: ['Part', 'Scenario record'], rows: Array.from({ length: Math.ceil(supporting.length / 16000) }, (_, i) => [i + 1, supporting.slice(i * 16000, (i + 1) * 16000)]), status: 'ready', warnings: [], asOf: result.asOf, sourceIds: [sourceId] } });
    const report = { id: reportId, ...(language ? { language } : {}), title, createdAt: now, sourceRevision: workspace.revision, reviewPending: true, sections, dashboardSnapshot: null, parentReportId: null };
    const operations = [{ type: 'source.upsert', source: { id: sourceId, name: 'Explicit planning scenario', kind: 'manual', status: 'imported', asOf: result.asOf, retrievedAt: now, url: null, note: JSON.stringify({ engineVersion: result.engineVersion, inputSha256: result.inputSha256, kind: result.kind, assumptionOrigin: result.request.assumptionOrigin }) } }, { type: 'report.add', report }];
    return { operations, reportId, title, kind: 'chart' };
}


/***/ }),

/***/ 2793:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseTupleDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
function parseTupleDef(def, refs) {
    if (def.rest) {
        return {
            type: "array",
            minItems: def.items.length,
            items: def.items
                .map((x, i) => (0, parseDef_js_1.parseDef)(x._def, {
                ...refs,
                currentPath: [...refs.currentPath, "items", `${i}`],
            }))
                .reduce((acc, x) => (x === undefined ? acc : [...acc, x]), []),
            additionalItems: (0, parseDef_js_1.parseDef)(def.rest._def, {
                ...refs,
                currentPath: [...refs.currentPath, "additionalItems"],
            }),
        };
    }
    else {
        return {
            type: "array",
            minItems: def.items.length,
            maxItems: def.items.length,
            items: def.items
                .map((x, i) => (0, parseDef_js_1.parseDef)(x._def, {
                ...refs,
                currentPath: [...refs.currentPath, "items", `${i}`],
            }))
                .reduce((acc, x) => (x === undefined ? acc : [...acc, x]), []),
        };
    }
}
exports.parseTupleDef = parseTupleDef;


/***/ }),

/***/ 2909:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseAnyDef = void 0;
const getRelativePath_js_1 = __webpack_require__(6379);
function parseAnyDef(refs) {
    if (refs.target !== "openAi") {
        return {};
    }
    const anyDefinitionPath = [
        ...refs.basePath,
        refs.definitionPath,
        refs.openAiAnyTypeName,
    ];
    refs.flags.hasReferencedOpenAiAnyType = true;
    return {
        $ref: refs.$refStrategy === "relative"
            ? (0, getRelativePath_js_1.getRelativePath)(anyDefinitionPath, refs.currentPath)
            : anyDefinitionPath.join("/"),
    };
}
exports.parseAnyDef = parseAnyDef;


/***/ }),

/***/ 3178:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseStringDef = exports.zodPatterns = void 0;
const errorMessages_js_1 = __webpack_require__(8950);
let emojiRegex = undefined;
/**
 * Generated from the regular expressions found here as of 2024-05-22:
 * https://github.com/colinhacks/zod/blob/master/src/types.ts.
 *
 * Expressions with /i flag have been changed accordingly.
 */
exports.zodPatterns = {
    /**
     * `c` was changed to `[cC]` to replicate /i flag
     */
    cuid: /^[cC][^\s-]{8,}$/,
    cuid2: /^[0-9a-z]+$/,
    ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
    /**
     * `a-z` was added to replicate /i flag
     */
    email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/,
    /**
     * Constructed a valid Unicode RegExp
     *
     * Lazily instantiate since this type of regex isn't supported
     * in all envs (e.g. React Native).
     *
     * See:
     * https://github.com/colinhacks/zod/issues/2433
     * Fix in Zod:
     * https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
     */
    emoji: () => {
        if (emojiRegex === undefined) {
            emojiRegex = RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
        }
        return emojiRegex;
    },
    /**
     * Unused
     */
    uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
    /**
     * Unused
     */
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
    ipv4Cidr: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/,
    /**
     * Unused
     */
    ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
    ipv6Cidr: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
    base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
    base64url: /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
    nanoid: /^[a-zA-Z0-9_-]{21}$/,
    jwt: /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/,
};
function parseStringDef(def, refs) {
    const res = {
        type: "string",
    };
    if (def.checks) {
        for (const check of def.checks) {
            switch (check.kind) {
                case "min":
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minLength", typeof res.minLength === "number"
                        ? Math.max(res.minLength, check.value)
                        : check.value, check.message, refs);
                    break;
                case "max":
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maxLength", typeof res.maxLength === "number"
                        ? Math.min(res.maxLength, check.value)
                        : check.value, check.message, refs);
                    break;
                case "email":
                    switch (refs.emailStrategy) {
                        case "format:email":
                            addFormat(res, "email", check.message, refs);
                            break;
                        case "format:idn-email":
                            addFormat(res, "idn-email", check.message, refs);
                            break;
                        case "pattern:zod":
                            addPattern(res, exports.zodPatterns.email, check.message, refs);
                            break;
                    }
                    break;
                case "url":
                    addFormat(res, "uri", check.message, refs);
                    break;
                case "uuid":
                    addFormat(res, "uuid", check.message, refs);
                    break;
                case "regex":
                    addPattern(res, check.regex, check.message, refs);
                    break;
                case "cuid":
                    addPattern(res, exports.zodPatterns.cuid, check.message, refs);
                    break;
                case "cuid2":
                    addPattern(res, exports.zodPatterns.cuid2, check.message, refs);
                    break;
                case "startsWith":
                    addPattern(res, RegExp(`^${escapeLiteralCheckValue(check.value, refs)}`), check.message, refs);
                    break;
                case "endsWith":
                    addPattern(res, RegExp(`${escapeLiteralCheckValue(check.value, refs)}$`), check.message, refs);
                    break;
                case "datetime":
                    addFormat(res, "date-time", check.message, refs);
                    break;
                case "date":
                    addFormat(res, "date", check.message, refs);
                    break;
                case "time":
                    addFormat(res, "time", check.message, refs);
                    break;
                case "duration":
                    addFormat(res, "duration", check.message, refs);
                    break;
                case "length":
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minLength", typeof res.minLength === "number"
                        ? Math.max(res.minLength, check.value)
                        : check.value, check.message, refs);
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maxLength", typeof res.maxLength === "number"
                        ? Math.min(res.maxLength, check.value)
                        : check.value, check.message, refs);
                    break;
                case "includes": {
                    addPattern(res, RegExp(escapeLiteralCheckValue(check.value, refs)), check.message, refs);
                    break;
                }
                case "ip": {
                    if (check.version !== "v6") {
                        addFormat(res, "ipv4", check.message, refs);
                    }
                    if (check.version !== "v4") {
                        addFormat(res, "ipv6", check.message, refs);
                    }
                    break;
                }
                case "base64url":
                    addPattern(res, exports.zodPatterns.base64url, check.message, refs);
                    break;
                case "jwt":
                    addPattern(res, exports.zodPatterns.jwt, check.message, refs);
                    break;
                case "cidr": {
                    if (check.version !== "v6") {
                        addPattern(res, exports.zodPatterns.ipv4Cidr, check.message, refs);
                    }
                    if (check.version !== "v4") {
                        addPattern(res, exports.zodPatterns.ipv6Cidr, check.message, refs);
                    }
                    break;
                }
                case "emoji":
                    addPattern(res, exports.zodPatterns.emoji(), check.message, refs);
                    break;
                case "ulid": {
                    addPattern(res, exports.zodPatterns.ulid, check.message, refs);
                    break;
                }
                case "base64": {
                    switch (refs.base64Strategy) {
                        case "format:binary": {
                            addFormat(res, "binary", check.message, refs);
                            break;
                        }
                        case "contentEncoding:base64": {
                            (0, errorMessages_js_1.setResponseValueAndErrors)(res, "contentEncoding", "base64", check.message, refs);
                            break;
                        }
                        case "pattern:zod": {
                            addPattern(res, exports.zodPatterns.base64, check.message, refs);
                            break;
                        }
                    }
                    break;
                }
                case "nanoid": {
                    addPattern(res, exports.zodPatterns.nanoid, check.message, refs);
                }
                case "toLowerCase":
                case "toUpperCase":
                case "trim":
                    break;
                default:
                    ((_) => { })(check);
            }
        }
    }
    return res;
}
exports.parseStringDef = parseStringDef;
function escapeLiteralCheckValue(literal, refs) {
    return refs.patternStrategy === "escape"
        ? escapeNonAlphaNumeric(literal)
        : literal;
}
const ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
function escapeNonAlphaNumeric(source) {
    let result = "";
    for (let i = 0; i < source.length; i++) {
        if (!ALPHA_NUMERIC.has(source[i])) {
            result += "\\";
        }
        result += source[i];
    }
    return result;
}
// Adds a "format" keyword to the schema. If a format exists, both formats will be joined in an allOf-node, along with subsequent ones.
function addFormat(schema, value, message, refs) {
    if (schema.format || schema.anyOf?.some((x) => x.format)) {
        if (!schema.anyOf) {
            schema.anyOf = [];
        }
        if (schema.format) {
            schema.anyOf.push({
                format: schema.format,
                ...(schema.errorMessage &&
                    refs.errorMessages && {
                    errorMessage: { format: schema.errorMessage.format },
                }),
            });
            delete schema.format;
            if (schema.errorMessage) {
                delete schema.errorMessage.format;
                if (Object.keys(schema.errorMessage).length === 0) {
                    delete schema.errorMessage;
                }
            }
        }
        schema.anyOf.push({
            format: value,
            ...(message &&
                refs.errorMessages && { errorMessage: { format: message } }),
        });
    }
    else {
        (0, errorMessages_js_1.setResponseValueAndErrors)(schema, "format", value, message, refs);
    }
}
// Adds a "pattern" keyword to the schema. If a pattern exists, both patterns will be joined in an allOf-node, along with subsequent ones.
function addPattern(schema, regex, message, refs) {
    if (schema.pattern || schema.allOf?.some((x) => x.pattern)) {
        if (!schema.allOf) {
            schema.allOf = [];
        }
        if (schema.pattern) {
            schema.allOf.push({
                pattern: schema.pattern,
                ...(schema.errorMessage &&
                    refs.errorMessages && {
                    errorMessage: { pattern: schema.errorMessage.pattern },
                }),
            });
            delete schema.pattern;
            if (schema.errorMessage) {
                delete schema.errorMessage.pattern;
                if (Object.keys(schema.errorMessage).length === 0) {
                    delete schema.errorMessage;
                }
            }
        }
        schema.allOf.push({
            pattern: stringifyRegExpWithFlags(regex, refs),
            ...(message &&
                refs.errorMessages && { errorMessage: { pattern: message } }),
        });
    }
    else {
        (0, errorMessages_js_1.setResponseValueAndErrors)(schema, "pattern", stringifyRegExpWithFlags(regex, refs), message, refs);
    }
}
// Mutate z.string.regex() in a best attempt to accommodate for regex flags when applyRegexFlags is true
function stringifyRegExpWithFlags(regex, refs) {
    if (!refs.applyRegexFlags || !regex.flags) {
        return regex.source;
    }
    // Currently handled flags
    const flags = {
        i: regex.flags.includes("i"),
        m: regex.flags.includes("m"),
        s: regex.flags.includes("s"), // `.` matches newlines
    };
    // The general principle here is to step through each character, one at a time, applying mutations as flags require. We keep track when the current character is escaped, and when it's inside a group /like [this]/ or (also) a range like /[a-z]/. The following is fairly brittle imperative code; edit at your peril!
    const source = flags.i ? regex.source.toLowerCase() : regex.source;
    let pattern = "";
    let isEscaped = false;
    let inCharGroup = false;
    let inCharRange = false;
    for (let i = 0; i < source.length; i++) {
        if (isEscaped) {
            pattern += source[i];
            isEscaped = false;
            continue;
        }
        if (flags.i) {
            if (inCharGroup) {
                if (source[i].match(/[a-z]/)) {
                    if (inCharRange) {
                        pattern += source[i];
                        pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
                        inCharRange = false;
                    }
                    else if (source[i + 1] === "-" && source[i + 2]?.match(/[a-z]/)) {
                        pattern += source[i];
                        inCharRange = true;
                    }
                    else {
                        pattern += `${source[i]}${source[i].toUpperCase()}`;
                    }
                    continue;
                }
            }
            else if (source[i].match(/[a-z]/)) {
                pattern += `[${source[i]}${source[i].toUpperCase()}]`;
                continue;
            }
        }
        if (flags.m) {
            if (source[i] === "^") {
                pattern += `(^|(?<=[\r\n]))`;
                continue;
            }
            else if (source[i] === "$") {
                pattern += `($|(?=[\r\n]))`;
                continue;
            }
        }
        if (flags.s && source[i] === ".") {
            pattern += inCharGroup ? `${source[i]}\r\n` : `[${source[i]}\r\n]`;
            continue;
        }
        pattern += source[i];
        if (source[i] === "\\") {
            isEscaped = true;
        }
        else if (inCharGroup && source[i] === "]") {
            inCharGroup = false;
        }
        else if (!inCharGroup && source[i] === "[") {
            inCharGroup = true;
        }
    }
    try {
        new RegExp(pattern);
    }
    catch {
        console.warn(`Could not convert regex pattern at ${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source`);
        return regex.source;
    }
    return pattern;
}


/***/ }),

/***/ 3237:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseNeverDef = void 0;
const any_js_1 = __webpack_require__(2909);
function parseNeverDef(refs) {
    return refs.target === "openAi"
        ? undefined
        : {
            not: (0, any_js_1.parseAnyDef)({
                ...refs,
                currentPath: [...refs.currentPath, "not"],
            }),
        };
}
exports.parseNeverDef = parseNeverDef;


/***/ }),

/***/ 3368:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.errorUtil = void 0;
var errorUtil;
(function (errorUtil) {
    errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    // biome-ignore lint:
    errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (exports.errorUtil = errorUtil = {}));


/***/ }),

/***/ 3524:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseDef = void 0;
const Options_js_1 = __webpack_require__(2626);
const selectParser_js_1 = __webpack_require__(2465);
const getRelativePath_js_1 = __webpack_require__(6379);
const any_js_1 = __webpack_require__(2909);
function parseDef(def, refs, forceResolution = false) {
    const seenItem = refs.seen.get(def);
    if (refs.override) {
        const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
        if (overrideResult !== Options_js_1.ignoreOverride) {
            return overrideResult;
        }
    }
    if (seenItem && !forceResolution) {
        const seenSchema = get$ref(seenItem, refs);
        if (seenSchema !== undefined) {
            return seenSchema;
        }
    }
    const newItem = { def, path: refs.currentPath, jsonSchema: undefined };
    refs.seen.set(def, newItem);
    const jsonSchemaOrGetter = (0, selectParser_js_1.selectParser)(def, def.typeName, refs);
    // If the return was a function, then the inner definition needs to be extracted before a call to parseDef (recursive)
    const jsonSchema = typeof jsonSchemaOrGetter === "function"
        ? parseDef(jsonSchemaOrGetter(), refs)
        : jsonSchemaOrGetter;
    if (jsonSchema) {
        addMeta(def, refs, jsonSchema);
    }
    if (refs.postProcess) {
        const postProcessResult = refs.postProcess(jsonSchema, def, refs);
        newItem.jsonSchema = jsonSchema;
        return postProcessResult;
    }
    newItem.jsonSchema = jsonSchema;
    return jsonSchema;
}
exports.parseDef = parseDef;
const get$ref = (item, refs) => {
    switch (refs.$refStrategy) {
        case "root":
            return { $ref: item.path.join("/") };
        case "relative":
            return { $ref: (0, getRelativePath_js_1.getRelativePath)(refs.currentPath, item.path) };
        case "none":
        case "seen": {
            if (item.path.length < refs.currentPath.length &&
                item.path.every((value, index) => refs.currentPath[index] === value)) {
                console.warn(`Recursive reference detected at ${refs.currentPath.join("/")}! Defaulting to any`);
                return (0, any_js_1.parseAnyDef)(refs);
            }
            return refs.$refStrategy === "seen" ? (0, any_js_1.parseAnyDef)(refs) : undefined;
        }
    }
};
const addMeta = (def, refs, jsonSchema) => {
    if (def.description) {
        jsonSchema.description = def.description;
        if (refs.markdownDescription) {
            jsonSchema.markdownDescription = def.description;
        }
    }
    return jsonSchema;
};


/***/ }),

/***/ 3858:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parsePromiseDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
function parsePromiseDef(def, refs) {
    return (0, parseDef_js_1.parseDef)(def.type._def, refs);
}
exports.parsePromiseDef = parsePromiseDef;


/***/ }),

/***/ 4158:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FinancePlanningRequestSchema = exports.FinancePlanningInstrumentSchema = exports.FinancePlanningMoneySchema = void 0;
const zod_1 = __webpack_require__(7552);
/** Transport money is decimal text; no inference from a missing amount or currency. */
exports.FinancePlanningMoneySchema = zod_1.z.string().max(20).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const money = exports.FinancePlanningMoneySchema, fraction = zod_1.z.number().finite().min(0).max(1), id = zod_1.z.string().min(1).max(200);
const common = { currency: zod_1.z.string().regex(/^[A-Z]{3}$/).refine(v => v !== 'XXX'), precision: zod_1.z.number().int().min(0).max(6), asOf: zod_1.z.string().date(), assumptionOrigin: zod_1.z.enum(['user_input', 'model_assumption']), assumptionNotes: zod_1.z.array(zod_1.z.string().max(500)).max(20).default([]) };
exports.FinancePlanningInstrumentSchema = zod_1.z.object({ id, label: zod_1.z.string().min(1).max(200), riskClass: zod_1.z.enum(['risk', 'nonrisk', 'unknown']), buyAllowed: zod_1.z.boolean(), sellAllowed: zod_1.z.boolean() }).strict();
exports.FinancePlanningRequestSchema = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.object({ ...common, kind: zod_1.z.literal('cashflow'), initialCapital: money, months: zod_1.z.number().int().min(1).max(1200), annualReturn: zod_1.z.number().finite().min(-.99).max(5), annualInflation: zod_1.z.number().finite().min(-.5).max(1), annualFeeRate: fraction, monthlyContribution: money, monthlyIncome: money, monthlyWithdrawal: money, withdrawalInflationAdjusted: zod_1.z.boolean(), targetEndBalance: money.optional() }).strict(),
    zod_1.z.object({ ...common, kind: zod_1.z.literal('income_goal'), capital: money, monthlyIncomeTarget: money, otherMonthlyIncome: money, annualCashYield: fraction, annualFeeRate: fraction, withholdingRate: fraction }).strict(),
    zod_1.z.object({ ...common, kind: zod_1.z.literal('rebalance'), planType: zod_1.z.enum(['brokerage', 'kr_dc', 'kr_irp', 'us_401k']), menuConfirmed: zod_1.z.boolean(), planMenu: zod_1.z.array(exports.FinancePlanningInstrumentSchema).max(100), positions: zod_1.z.array(zod_1.z.object({ instrumentId: id, currentValue: money }).strict()).max(100), cash: money, contribution: money, reserve: money, feeReserve: money, fees: zod_1.z.object({ fixedPerTrade: money, proportionalRate: fraction }).strict(), targetWeights: zod_1.z.array(zod_1.z.object({ instrumentId: id, weight: fraction }).strict()).min(1).max(100), constraints: zod_1.z.object({ lockedIds: zod_1.z.array(id).max(100).default([]), excludedIds: zod_1.z.array(id).max(100).default([]), bounds: zod_1.z.array(zod_1.z.object({ instrumentId: id, minWeight: fraction, maxWeight: fraction }).strict()).max(100).default([]), maxRiskWeight: fraction.optional() }).strict() }).strict(),
]);


/***/ }),

/***/ 4519:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseSetDef = void 0;
const errorMessages_js_1 = __webpack_require__(8950);
const parseDef_js_1 = __webpack_require__(3524);
function parseSetDef(def, refs) {
    const items = (0, parseDef_js_1.parseDef)(def.valueType._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items"],
    });
    const schema = {
        type: "array",
        uniqueItems: true,
        items,
    };
    if (def.minSize) {
        (0, errorMessages_js_1.setResponseValueAndErrors)(schema, "minItems", def.minSize.value, def.minSize.message, refs);
    }
    if (def.maxSize) {
        (0, errorMessages_js_1.setResponseValueAndErrors)(schema, "maxItems", def.maxSize.value, def.maxSize.message, refs);
    }
    return schema;
}
exports.parseSetDef = parseSetDef;


/***/ }),

/***/ 4633:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.zodToJsonSchema = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const Refs_js_1 = __webpack_require__(1076);
const any_js_1 = __webpack_require__(2909);
const zodToJsonSchema = (schema, options) => {
    const refs = (0, Refs_js_1.getRefs)(options);
    let definitions = typeof options === "object" && options.definitions
        ? Object.entries(options.definitions).reduce((acc, [name, schema]) => ({
            ...acc,
            [name]: (0, parseDef_js_1.parseDef)(schema._def, {
                ...refs,
                currentPath: [...refs.basePath, refs.definitionPath, name],
            }, true) ?? (0, any_js_1.parseAnyDef)(refs),
        }), {})
        : undefined;
    const name = typeof options === "string"
        ? options
        : options?.nameStrategy === "title"
            ? undefined
            : options?.name;
    const main = (0, parseDef_js_1.parseDef)(schema._def, name === undefined
        ? refs
        : {
            ...refs,
            currentPath: [...refs.basePath, refs.definitionPath, name],
        }, false) ?? (0, any_js_1.parseAnyDef)(refs);
    const title = typeof options === "object" &&
        options.name !== undefined &&
        options.nameStrategy === "title"
        ? options.name
        : undefined;
    if (title !== undefined) {
        main.title = title;
    }
    if (refs.flags.hasReferencedOpenAiAnyType) {
        if (!definitions) {
            definitions = {};
        }
        if (!definitions[refs.openAiAnyTypeName]) {
            definitions[refs.openAiAnyTypeName] = {
                // Skipping "object" as no properties can be defined and additionalProperties must be "false"
                type: ["string", "number", "integer", "boolean", "array", "null"],
                items: {
                    $ref: refs.$refStrategy === "relative"
                        ? "1"
                        : [
                            ...refs.basePath,
                            refs.definitionPath,
                            refs.openAiAnyTypeName,
                        ].join("/"),
                },
            };
        }
    }
    const combined = name === undefined
        ? definitions
            ? {
                ...main,
                [refs.definitionPath]: definitions,
            }
            : main
        : {
            $ref: [
                ...(refs.$refStrategy === "relative" ? [] : refs.basePath),
                refs.definitionPath,
                name,
            ].join("/"),
            [refs.definitionPath]: {
                ...definitions,
                [name]: main,
            },
        };
    if (refs.target === "jsonSchema7") {
        combined.$schema = "http://json-schema.org/draft-07/schema#";
    }
    else if (refs.target === "jsonSchema2019-09" || refs.target === "openAi") {
        combined.$schema = "https://json-schema.org/draft/2019-09/schema#";
    }
    if (refs.target === "openAi" &&
        ("anyOf" in combined ||
            "oneOf" in combined ||
            "allOf" in combined ||
            ("type" in combined && Array.isArray(combined.type)))) {
        console.warn("Warning: OpenAI may not support schemas with unions as roots! Try wrapping it in an object property.");
    }
    return combined;
};
exports.zodToJsonSchema = zodToJsonSchema;


/***/ }),

/***/ 4836:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseLiteralDef = void 0;
function parseLiteralDef(def, refs) {
    const parsedType = typeof def.value;
    if (parsedType !== "bigint" &&
        parsedType !== "number" &&
        parsedType !== "boolean" &&
        parsedType !== "string") {
        return {
            type: Array.isArray(def.value) ? "array" : "object",
        };
    }
    if (refs.target === "openApi3") {
        return {
            type: parsedType === "bigint" ? "integer" : parsedType,
            enum: [def.value],
        };
    }
    return {
        type: parsedType === "bigint" ? "integer" : parsedType,
        const: def.value,
    };
}
exports.parseLiteralDef = parseLiteralDef;


/***/ }),

/***/ 5187:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseDateDef = void 0;
const errorMessages_js_1 = __webpack_require__(8950);
function parseDateDef(def, refs, overrideDateStrategy) {
    const strategy = overrideDateStrategy ?? refs.dateStrategy;
    if (Array.isArray(strategy)) {
        return {
            anyOf: strategy.map((item, i) => parseDateDef(def, refs, item)),
        };
    }
    switch (strategy) {
        case "string":
        case "format:date-time":
            return {
                type: "string",
                format: "date-time",
            };
        case "format:date":
            return {
                type: "string",
                format: "date",
            };
        case "integer":
            return integerDateParser(def, refs);
    }
}
exports.parseDateDef = parseDateDef;
const integerDateParser = (def, refs) => {
    const res = {
        type: "integer",
        format: "unix-time",
    };
    if (refs.target === "openApi3") {
        return res;
    }
    for (const check of def.checks) {
        switch (check.kind) {
            case "min":
                (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minimum", check.value, // This is in milliseconds
                check.message, refs);
                break;
            case "max":
                (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maximum", check.value, // This is in milliseconds
                check.message, refs);
                break;
        }
    }
    return res;
};


/***/ }),

/***/ 5653:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
const ZodError_js_1 = __webpack_require__(8651);
const util_js_1 = __webpack_require__(2034);
const errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
        case ZodError_js_1.ZodIssueCode.invalid_type:
            if (issue.received === util_js_1.ZodParsedType.undefined) {
                message = "Required";
            }
            else {
                message = `Expected ${issue.expected}, received ${issue.received}`;
            }
            break;
        case ZodError_js_1.ZodIssueCode.invalid_literal:
            message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util_js_1.util.jsonStringifyReplacer)}`;
            break;
        case ZodError_js_1.ZodIssueCode.unrecognized_keys:
            message = `Unrecognized key(s) in object: ${util_js_1.util.joinValues(issue.keys, ", ")}`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_union:
            message = `Invalid input`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_union_discriminator:
            message = `Invalid discriminator value. Expected ${util_js_1.util.joinValues(issue.options)}`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_enum_value:
            message = `Invalid enum value. Expected ${util_js_1.util.joinValues(issue.options)}, received '${issue.received}'`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_arguments:
            message = `Invalid function arguments`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_return_type:
            message = `Invalid function return type`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_date:
            message = `Invalid date`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_string:
            if (typeof issue.validation === "object") {
                if ("includes" in issue.validation) {
                    message = `Invalid input: must include "${issue.validation.includes}"`;
                    if (typeof issue.validation.position === "number") {
                        message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
                    }
                }
                else if ("startsWith" in issue.validation) {
                    message = `Invalid input: must start with "${issue.validation.startsWith}"`;
                }
                else if ("endsWith" in issue.validation) {
                    message = `Invalid input: must end with "${issue.validation.endsWith}"`;
                }
                else {
                    util_js_1.util.assertNever(issue.validation);
                }
            }
            else if (issue.validation !== "regex") {
                message = `Invalid ${issue.validation}`;
            }
            else {
                message = "Invalid";
            }
            break;
        case ZodError_js_1.ZodIssueCode.too_small:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "bigint")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
            else
                message = "Invalid input";
            break;
        case ZodError_js_1.ZodIssueCode.too_big:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "bigint")
                message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
            else
                message = "Invalid input";
            break;
        case ZodError_js_1.ZodIssueCode.custom:
            message = `Invalid input`;
            break;
        case ZodError_js_1.ZodIssueCode.invalid_intersection_types:
            message = `Intersection results could not be merged`;
            break;
        case ZodError_js_1.ZodIssueCode.not_multiple_of:
            message = `Number must be a multiple of ${issue.multipleOf}`;
            break;
        case ZodError_js_1.ZodIssueCode.not_finite:
            message = "Number must be finite";
            break;
        default:
            message = _ctx.defaultError;
            util_js_1.util.assertNever(issue);
    }
    return { message };
};
exports["default"] = errorMap;


/***/ }),

/***/ 5778:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FinanceComputeRequestSchema = exports.FinanceComputeInputSchema = exports.FinanceComputeHistorySchema = exports.FinanceComputeProvenanceSchema = void 0;
const zod_1 = __webpack_require__(7552);
const finite = zod_1.z.number().finite();
const positive = finite.positive().max(1e12);
const id = zod_1.z.string().min(1).max(200);
const assetIds = zod_1.z.array(id).min(1).max(12).refine(ids => new Set(ids).size === ids.length, 'Duplicate asset IDs');
const currency = zod_1.z.string().regex(/^[A-Z]{3}$/).refine(value => value !== 'XXX', 'Currency must be known');
exports.FinanceComputeProvenanceSchema = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.object({ kind: zod_1.z.literal('observed'), sourceUrls: zod_1.z.array(zod_1.z.string().url().max(2000).refine(url => /^https?:\/\//i.test(url))).min(1).max(100), retrievedAt: zod_1.z.string().datetime({ offset: true }) }).strict(),
    zod_1.z.object({ kind: zod_1.z.literal('scenario'), origin: zod_1.z.enum(['user_input', 'model_assumption']), label: zod_1.z.string().min(1).max(500), declaredAt: zod_1.z.string().datetime({ offset: true }) }).strict(),
]);
/** Observed prices and their provenance are supplied by the service, never by a model tool argument. */
exports.FinanceComputeHistorySchema = zod_1.z.object({
    assetId: id, symbol: zod_1.z.string().min(1).max(80), currency,
    priceBasis: zod_1.z.enum(['price', 'total_return']), adjustment: zod_1.z.enum(['split_adjusted', 'unknown']),
    prices: zod_1.z.array(zod_1.z.object({ date: zod_1.z.string().date(), close: positive }).strict()).min(31).max(2600),
}).strict();
exports.FinanceComputeInputSchema = zod_1.z.object({
    histories: zod_1.z.array(exports.FinanceComputeHistorySchema).max(12), provenance: exports.FinanceComputeProvenanceSchema,
}).strict();
exports.FinanceComputeRequestSchema = zod_1.z.discriminatedUnion('kind', [
    zod_1.z.object({ kind: zod_1.z.literal('allocation'), method: zod_1.z.enum(['min_variance', 'risk_parity']), assetIds,
        minWeight: finite.min(0).max(1).default(0), maxWeight: finite.min(0).max(1).default(1),
        shrinkage: finite.min(0.01).max(1).default(0.1), periodsPerYear: zod_1.z.number().int().min(1).max(366).default(252),
    }).strict(),
    zod_1.z.object({ kind: zod_1.z.literal('forecast'), assetIds: zod_1.z.array(id).length(1), horizon: zod_1.z.number().int().min(1).max(252).default(63),
        paths: zod_1.z.number().int().min(200).max(2000).default(1000), seed: zod_1.z.number().int().min(0).max(4294967295).default(20261018),
    }).strict(),
    zod_1.z.object({ kind: zod_1.z.literal('option'), optionType: zod_1.z.enum(['call', 'put']), symbol: zod_1.z.string().min(1).max(80), currency,
        spot: positive, strike: positive, rate: finite.min(-0.5).max(1), dividendYield: finite.min(0).max(1).default(0),
        volatility: finite.min(0.0001).max(5), years: finite.min(1 / 36500).max(30),
    }).strict(),
]);


/***/ }),

/***/ 5867:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseOptionalDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const any_js_1 = __webpack_require__(2909);
const parseOptionalDef = (def, refs) => {
    if (refs.currentPath.toString() === refs.propertyPath?.toString()) {
        return (0, parseDef_js_1.parseDef)(def.innerType._def, refs);
    }
    const innerSchema = (0, parseDef_js_1.parseDef)(def.innerType._def, {
        ...refs,
        currentPath: [...refs.currentPath, "anyOf", "1"],
    });
    return innerSchema
        ? {
            anyOf: [
                {
                    not: (0, any_js_1.parseAnyDef)(refs),
                },
                innerSchema,
            ],
        }
        : (0, any_js_1.parseAnyDef)(refs);
};
exports.parseOptionalDef = parseOptionalDef;


/***/ }),

/***/ 5973:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseUnknownDef = void 0;
const any_js_1 = __webpack_require__(2909);
function parseUnknownDef(refs) {
    return (0, any_js_1.parseAnyDef)(refs);
}
exports.parseUnknownDef = parseUnknownDef;


/***/ }),

/***/ 6163:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseBrandedDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
function parseBrandedDef(_def, refs) {
    return (0, parseDef_js_1.parseDef)(_def.type._def, refs);
}
exports.parseBrandedDef = parseBrandedDef;


/***/ }),

/***/ 6172:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseObjectDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
function parseObjectDef(def, refs) {
    const forceOptionalIntoNullable = refs.target === "openAi";
    const result = {
        type: "object",
        properties: {},
    };
    const required = [];
    const shape = def.shape();
    for (const propName in shape) {
        let propDef = shape[propName];
        if (propDef === undefined || propDef._def === undefined) {
            continue;
        }
        let propOptional = safeIsOptional(propDef);
        if (propOptional && forceOptionalIntoNullable) {
            if (propDef._def.typeName === "ZodOptional") {
                propDef = propDef._def.innerType;
            }
            if (!propDef.isNullable()) {
                propDef = propDef.nullable();
            }
            propOptional = false;
        }
        const parsedDef = (0, parseDef_js_1.parseDef)(propDef._def, {
            ...refs,
            currentPath: [...refs.currentPath, "properties", propName],
            propertyPath: [...refs.currentPath, "properties", propName],
        });
        if (parsedDef === undefined) {
            continue;
        }
        result.properties[propName] = parsedDef;
        if (!propOptional) {
            required.push(propName);
        }
    }
    if (required.length) {
        result.required = required;
    }
    const additionalProperties = decideAdditionalProperties(def, refs);
    if (additionalProperties !== undefined) {
        result.additionalProperties = additionalProperties;
    }
    return result;
}
exports.parseObjectDef = parseObjectDef;
function decideAdditionalProperties(def, refs) {
    if (def.catchall._def.typeName !== "ZodNever") {
        return (0, parseDef_js_1.parseDef)(def.catchall._def, {
            ...refs,
            currentPath: [...refs.currentPath, "additionalProperties"],
        });
    }
    switch (def.unknownKeys) {
        case "passthrough":
            return refs.allowedAdditionalProperties;
        case "strict":
            return refs.rejectedAdditionalProperties;
        case "strip":
            return refs.removeAdditionalStrategy === "strict"
                ? refs.allowedAdditionalProperties
                : refs.rejectedAdditionalProperties;
    }
}
function safeIsOptional(schema) {
    try {
        return schema.isOptional();
    }
    catch {
        return true;
    }
}


/***/ }),

/***/ 6260:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseCatchDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const parseCatchDef = (def, refs) => {
    return (0, parseDef_js_1.parseDef)(def.innerType._def, refs);
};
exports.parseCatchDef = parseCatchDef;


/***/ }),

/***/ 6370:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));


/***/ }),

/***/ 6379:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getRelativePath = void 0;
const getRelativePath = (pathA, pathB) => {
    let i = 0;
    for (; i < pathA.length && i < pathB.length; i++) {
        if (pathA[i] !== pathB[i])
            break;
    }
    return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};
exports.getRelativePath = getRelativePath;


/***/ }),

/***/ 6750:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseEnumDef = void 0;
function parseEnumDef(def) {
    return {
        type: "string",
        enum: Array.from(def.values),
    };
}
exports.parseEnumDef = parseEnumDef;


/***/ }),

/***/ 6773:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseNativeEnumDef = void 0;
function parseNativeEnumDef(def) {
    const object = def.values;
    const actualKeys = Object.keys(def.values).filter((key) => {
        return typeof object[object[key]] !== "number";
    });
    const actualValues = actualKeys.map((key) => object[key]);
    const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
    return {
        type: parsedTypes.length === 1
            ? parsedTypes[0] === "string"
                ? "string"
                : "number"
            : ["string", "number"],
        enum: actualValues,
    };
}
exports.parseNativeEnumDef = parseNativeEnumDef;


/***/ }),

/***/ 7054:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseRecordDef = void 0;
const v3_1 = __webpack_require__(9164);
const parseDef_js_1 = __webpack_require__(3524);
const string_js_1 = __webpack_require__(3178);
const branded_js_1 = __webpack_require__(6163);
const any_js_1 = __webpack_require__(2909);
function parseRecordDef(def, refs) {
    if (refs.target === "openAi") {
        console.warn("Warning: OpenAI may not support records in schemas! Try an array of key-value pairs instead.");
    }
    if (refs.target === "openApi3" &&
        def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodEnum) {
        return {
            type: "object",
            required: def.keyType._def.values,
            properties: def.keyType._def.values.reduce((acc, key) => ({
                ...acc,
                [key]: (0, parseDef_js_1.parseDef)(def.valueType._def, {
                    ...refs,
                    currentPath: [...refs.currentPath, "properties", key],
                }) ?? (0, any_js_1.parseAnyDef)(refs),
            }), {}),
            additionalProperties: refs.rejectedAdditionalProperties,
        };
    }
    const schema = {
        type: "object",
        additionalProperties: (0, parseDef_js_1.parseDef)(def.valueType._def, {
            ...refs,
            currentPath: [...refs.currentPath, "additionalProperties"],
        }) ?? refs.allowedAdditionalProperties,
    };
    if (refs.target === "openApi3") {
        return schema;
    }
    if (def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodString &&
        def.keyType._def.checks?.length) {
        const { type, ...keyType } = (0, string_js_1.parseStringDef)(def.keyType._def, refs);
        return {
            ...schema,
            propertyNames: keyType,
        };
    }
    else if (def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodEnum) {
        return {
            ...schema,
            propertyNames: {
                enum: def.keyType._def.values,
            },
        };
    }
    else if (def.keyType?._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodBranded &&
        def.keyType._def.type._def.typeName === v3_1.ZodFirstPartyTypeKind.ZodString &&
        def.keyType._def.type._def.checks?.length) {
        const { type, ...keyType } = (0, branded_js_1.parseBrandedDef)(def.keyType._def, refs);
        return {
            ...schema,
            propertyNames: keyType,
        };
    }
    return schema;
}
exports.parseRecordDef = parseRecordDef;


/***/ }),

/***/ 7236:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseBigintDef = void 0;
const errorMessages_js_1 = __webpack_require__(8950);
function parseBigintDef(def, refs) {
    const res = {
        type: "integer",
        format: "int64",
    };
    if (!def.checks)
        return res;
    for (const check of def.checks) {
        switch (check.kind) {
            case "min":
                if (refs.target === "jsonSchema7") {
                    if (check.inclusive) {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minimum", check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "exclusiveMinimum", check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMinimum = true;
                    }
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minimum", check.value, check.message, refs);
                }
                break;
            case "max":
                if (refs.target === "jsonSchema7") {
                    if (check.inclusive) {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maximum", check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "exclusiveMaximum", check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMaximum = true;
                    }
                    (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maximum", check.value, check.message, refs);
                }
                break;
            case "multipleOf":
                (0, errorMessages_js_1.setResponseValueAndErrors)(res, "multipleOf", check.value, check.message, refs);
                break;
        }
    }
    return res;
}
exports.parseBigintDef = parseBigintDef;


/***/ }),

/***/ 7294:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseNullDef = void 0;
function parseNullDef(refs) {
    return refs.target === "openApi3"
        ? {
            enum: ["null"],
            nullable: true,
        }
        : {
            type: "null",
        };
}
exports.parseNullDef = parseNullDef;


/***/ }),

/***/ 7552:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.z = void 0;
const z = __importStar(__webpack_require__(9325));
exports.z = z;
__exportStar(__webpack_require__(9325), exports);
exports["default"] = z;


/***/ }),

/***/ 7598:
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),

/***/ 7939:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


const {z}=__webpack_require__(7552),{zodToJsonSchema}=__webpack_require__(9340);
const {calculateFinance}=__webpack_require__(9019);
const {financeCalculationArtifact}=__webpack_require__(8201);
const {FinanceComputeRequestSchema,FinanceComputeInputSchema,FinanceComputeProvenanceSchema}=__webpack_require__(5778);
const {runFinancePlanning}=__webpack_require__(9405);
const {financePlanningArtifact}=__webpack_require__(2772);
const {financePortfolioValuation,financePortfolioValuationArtifact}=__webpack_require__(9568);
const {FinancePlanningRequestSchema}=__webpack_require__(4158);
const {__financeWorkspaceSchema:workspace,__financeSourceSchema:source,__financeOperationSchemas:operations,FinanceReportLanguageSchema,validateFinanceWorkspace,validateFinanceOperation}=__webpack_require__(726);
const n=z.number().finite(),nonnegative=n.min(0),id=z.string().min(1).max(200),str=z.string().max(20000),strings=z.array(str).max(1000),money=z.string().max(30),nullableDate=z.string().max(100).nullable();
const metric=z.object({id,label:z.string().max(300),value:z.union([z.string().max(100),n,z.null()]),unit:z.enum(['money','fraction','month'])}).strict();
const point=z.object({month:z.number().int().min(0).max(1200),balance:money,realBalance:money,contribution:money,income:money,withdrawalRequested:money,withdrawalPaid:money,fees:money,shortfall:money}).strict();
const planningResult=z.object({schemaVersion:z.literal(1),engineVersion:z.literal('finance-planning-v1'),kind:z.enum(['cashflow','income_goal','rebalance']),status:z.enum(['ok','infeasible']),currency:z.string().regex(/^[A-Z]{3}$/),precision:z.number().int().min(0).max(6),asOf:z.string().date(),inputSha256:z.string().regex(/^[a-f0-9]{64}$/),summary:str,metrics:z.array(metric).max(100),monthlyProjection:z.array(point).max(1201),annualProjection:z.array(point).max(101),trades:z.array(z.object({instrumentId:id,label:z.string().max(200),side:z.enum(['buy','sell','hold']),currentValue:money,targetValue:money,amount:money,estimatedFee:money,targetWeight:n}).strict()).max(100),charts:z.array(z.object({id,label:z.string().max(300),type:z.enum(['line','bar']),points:z.array(z.object({x:z.union([n,z.string().max(200)]),y:n}).strict()).max(1201)}).strict()).max(20),assumptions:strings,warnings:strings,errors:z.array(z.object({code:id,field:id.optional(),detail:str.optional()}).strict()).max(1000),request:FinancePlanningRequestSchema}).strict();
const refresh=z.object({baseRevision:z.number().int().nonnegative(),status:z.enum(['ok','unavailable']).optional(),message:str,operations:z.array(z.union([operations['source.upsert'],operations['quotes.import']])).max(20000).optional()}).strict();
const valuation=z.object({status:z.enum(['ok','partial','unavailable']),baseRevision:z.number().int().nonnegative(),asOf:nullableDate,retrievedAt:nullableDate,groups:z.array(z.object({currency:z.string().regex(/^[A-Z]{3}$/),complete:z.boolean(),totalValue:nonnegative.nullable(),knownSubtotal:nonnegative,items:z.array(z.object({holdingId:id,assetId:id,symbol:z.string().max(160),quantity:nonnegative,price:nonnegative.nullable(),marketValue:nonnegative.nullable(),weight:n.nullable(),asOf:nullableDate,sourceId:id.nullable()}).strict()).max(10000),missingAssetIds:z.array(id).max(10000)}).strict()).max(1000),sources:z.array(source).max(1000),warnings:strings,providerMessage:str,coverage:z.object({positions:z.number().int().nonnegative(),pricedPositions:z.number().int().nonnegative(),missingPositions:z.number().int().nonnegative()}).strict()}).strict();
const commonPresentation={title:z.string().max(300).optional(),language:FinanceReportLanguageSchema.optional(),narrative:str.optional(),chartLabels:z.record(z.string().max(200)).optional()};
const planPresentation=z.object({...commonPresentation,chartTitle:z.string().max(300).optional(),tradeTitle:z.string().max(300).optional(),tradeColumns:z.array(z.string().max(200)).length(4).optional(),tradeActions:z.object({buy:z.string().max(200),sell:z.string().max(200),hold:z.string().max(200)}).strict().optional()}).strict();
const valuePresentation=z.object({...commonPresentation,chartTitles:z.record(z.string().max(300)).optional()}).strict();
const dataResult=z.object({status:z.enum(['ok','partial','unconnected','error']),sourceUrls:z.array(z.string().max(2000)).max(100),asOf:nullableDate,retrievedAt:z.string().max(100),columns:z.array(z.string().max(300)).max(100),rows:z.array(z.array(z.union([str,n,z.null()])).max(100)).max(20000),warnings:strings,providers:z.array(z.object({id,label:z.string().max(300),status:z.enum(['ok','partial','unavailable','error']),coverage:str,rights:str,sourceUrls:z.array(z.string().max(2000)).max(100)}).strict()).max(100).optional()}).strict();
const computeResult=z.object({schemaVersion:z.literal(1),engineVersion:z.literal('finance-compute-v1'),kind:z.enum(['allocation','forecast','option']),method:str,title:z.string().max(300),provenance:FinanceComputeProvenanceSchema,input:z.object({symbols:z.array(z.string().max(80)).max(12),assetIds:z.array(id).max(12),currency:z.string().max(3),startDate:nullableDate,endDate:nullableDate,observations:z.number().int().nonnegative(),inputSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),metrics:z.array(z.object({id,label:str,value:n,unit:z.string().max(100)}).strict()).max(100),series:z.array(z.object({id,label:str,chart:z.enum(['line','bar','fan']),xLabel:str,yLabel:str,points:z.array(z.object({x:z.union([n,z.string().max(300)]),y:n,p05:n.optional(),p25:n.optional(),p50:n.optional(),p75:n.optional(),p95:n.optional()}).strict()).max(10000)}).strict()).max(100),tables:z.array(z.object({id,title:str,columns:z.array(z.string().max(300)).max(100),rows:z.array(z.array(z.union([str,n,z.null()])).max(100)).max(10000)}).strict()).max(100),assumptions:strings,warnings:strings,citations:z.array(z.object({title:str,url:z.string().url().max(2000)}).strict()).max(100),diagnostics:z.object({iterations:z.number().int().nonnegative(),converged:z.literal(true),residual:n,seed:n.optional(),paths:n.optional()}).strict(),inputEvidence:z.array(dataResult).max(100).optional(),requestSnapshot:FinanceComputeRequestSchema.optional()}).strict();
const computePresentation=z.object({language:FinanceReportLanguageSchema.optional(),narrative:str.optional(),chartTitle:z.string().max(300).optional(),metricsTitle:z.string().max(300).optional(),metricLabels:z.record(z.string().max(300)).optional(),highlightMetricIds:z.array(id).max(100).optional(),comparisonIndexes:z.array(z.number().int().nonnegative()).max(100).optional()}).strict();
const inputs={compute:z.object({request:FinanceComputeRequestSchema,input:FinanceComputeInputSchema}).strict(),'compute.artifact':z.object({result:computeResult,workspace,presentation:computePresentation.optional(),title:z.string().max(300).optional()}).strict(),planning:FinancePlanningRequestSchema,valuation:z.object({workspace,refreshResult:refresh}).strict(),'planning.artifact':z.object({result:planningResult,workspace,presentation:planPresentation.optional()}).strict(),'portfolio.artifact':z.object({result:valuation,workspace,presentation:valuePresentation.optional()}).strict()};
const artifact=z.object({operations:z.array(z.union([operations['source.upsert'],operations['report.add']])).max(1000),reportId:id,title:z.string().max(300),kind:z.literal('chart')}).strict();
const outputs={compute:computeResult,'compute.artifact':artifact,planning:planningResult,valuation,'planning.artifact':artifact,'portfolio.artifact':artifact};
function bounded(value,max=4*1024*1024){let text;try{text=JSON.stringify(value);}catch{throw new Error('finance_plugin_payload_invalid');}if(typeof text!=='string'||Buffer.byteLength(text)>max)throw new Error('finance_plugin_payload_too_large');return JSON.parse(text);}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value;}
function callPureTool(action,payload){if(!Object.hasOwn(inputs,action))throw new Error('finance_plugin_action_unsupported');const input=inputs[action].parse(bounded(payload));let result;
 if(action==='compute')result=calculateFinance(input.request,input.input);
 else if(action==='compute.artifact')result=financeCalculationArtifact(input.result,validateFinanceWorkspace(input.workspace),input.title,input.presentation);
 else if(action==='planning')result=runFinancePlanning(input);
 else if(action==='valuation')result=financePortfolioValuation(validateFinanceWorkspace(input.workspace),input.refreshResult);
 else if(action==='planning.artifact'){const canonical=runFinancePlanning(input.result.request);if(JSON.stringify(stable(input.result))!==JSON.stringify(stable(canonical)))throw new Error('finance_plugin_planning_result_mismatch');result=financePlanningArtifact(input.result,validateFinanceWorkspace(input.workspace),input.presentation);}
 else result=financePortfolioValuationArtifact(input.result,validateFinanceWorkspace(input.workspace),input.presentation);
 const checked=outputs[action].parse(bounded(result,8*1024*1024));if(action.endsWith('.artifact'))checked.operations.forEach(validateFinanceOperation);return checked;
}
const scenarioCompute=inputs.compute.extend({input:FinanceComputeInputSchema.extend({provenance:FinanceComputeProvenanceSchema.options[1]}).strict()}).strict();
const schemaDocument=schema=>{const document=zodToJsonSchema(schema,{$refStrategy:'none'});return document.type?document:{type:'object',...document};};
const toolDefinitions=[['finance_compute','compute','Calculate a declared scenario allocation, forecast or option model. Supplied data is a scenario, never independently verified market evidence.'],['finance_plan','planning','Calculate an explicit cash-flow, income-goal or account rebalance scenario. Does not fetch data or execute trades.'],['finance_valuation','valuation','Value supplied holdings only from supplied compatible provider refresh observations. No network request or price inference.']].map(([name,action,description])=>({name,description,inputSchema:schemaDocument(action==='compute'?scenarioCompute:inputs[action]),outputSchema:schemaDocument(outputs[action]),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));
module.exports={apiVersion:1,callPureTool,toolDefinitions};


/***/ }),

/***/ 7987:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseUndefinedDef = void 0;
const any_js_1 = __webpack_require__(2909);
function parseUndefinedDef(refs) {
    return {
        not: (0, any_js_1.parseAnyDef)(refs),
    };
}
exports.parseUndefinedDef = parseUndefinedDef;


/***/ }),

/***/ 8147:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseBooleanDef = void 0;
function parseBooleanDef() {
    return {
        type: "boolean",
    };
}
exports.parseBooleanDef = parseBooleanDef;


/***/ }),

/***/ 8201:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.financeCalculationArtifact = financeCalculationArtifact;
exports.financeConversationArtifact = financeConversationArtifact;
const finance_1 = __webpack_require__(726);
/** Compile host-computed numbers into the existing portable report/table contract. */
function financeCalculationArtifact(artifact, workspace, title = artifact.title, presentation = {}) {
    const language = presentation.language ? finance_1.FinanceReportLanguageSchema.parse(presentation.language) : undefined;
    if ([...title].length > 80)
        title = `${artifact.input.symbols.slice(0, 3).join(' · ')} · ${artifact.title}`;
    const now = new Date().toISOString(), sourceId = (0, finance_1.financeId)('source'), sourceUrls = artifact.provenance.kind === 'observed' ? artifact.provenance.sourceUrls : artifact.citations.map(c => c.url);
    const operations = [{ type: 'source.upsert', source: { id: sourceId, name: artifact.provenance.kind === 'observed' ? '계산에 사용한 가격' : '가정 시나리오', kind: artifact.provenance.kind === 'observed' ? 'provider' : 'manual', status: artifact.provenance.kind === 'observed' ? 'connected' : 'imported', asOf: artifact.input.endDate, retrievedAt: artifact.provenance.kind === 'observed' ? artifact.provenance.retrievedAt : now, url: sourceUrls[0] ?? null, note: JSON.stringify({ method: artifact.method, parameters: artifact.requestSnapshot, input: artifact.input, provenance: artifact.provenance, diagnostics: artifact.diagnostics, citations: artifact.citations }).slice(0, 20000) } }];
    const sections = artifact.tables.map(table => {
        const main = artifact.kind === 'allocation' ? table.id === 'allocation' : artifact.kind === 'forecast' ? table.id === 'fan' : table.id === 'payoff';
        const widget = (0, finance_1.createFinanceWidget)('chart', table.title);
        widget.chartType = main ? (artifact.kind === 'allocation' ? 'bar' : 'line') : 'table';
        widget.width = 'full';
        widget.notes = artifact.input.currency;
        widget.metric = `compute:${artifact.kind}:${main ? (artifact.kind === 'allocation' ? 'weights' : artifact.kind === 'forecast' ? 'fan' : 'value') : table.id}`;
        return { id: (0, finance_1.financeId)('section'), title: main ? (presentation.chartTitle ?? table.title) : table.title, kind: main ? 'widget' : 'sources', presentation: main ? 'chart' : 'supporting', narrative: '', widget: main ? widget : null, projection: { columns: table.columns, rows: table.rows, status: 'ready', warnings: artifact.warnings, asOf: artifact.input.endDate, sourceIds: [sourceId] } };
    });
    sections.sort((a, b) => (a.kind === 'widget' ? 0 : 1) - (b.kind === 'widget' ? 0 : 1));
    const metricsTitle = presentation.metricsTitle ?? (language && !language.startsWith('ko') ? 'Key figures' : '계산 요약');
    const metricsWidget = (0, finance_1.createFinanceWidget)('chart', metricsTitle);
    metricsWidget.metric = `compute:${artifact.kind}:metrics`;
    const selectedMetrics = presentation.highlightMetricIds?.length ? artifact.metrics.filter(metric => presentation.highlightMetricIds.includes(metric.id)) : artifact.metrics.filter(metric => !["constraint_violation", "sample_volatility"].includes(metric.id)).slice(0, 4);
    sections.splice(1, 0, { id: (0, finance_1.financeId)('section'), title: metricsTitle, kind: 'widget', narrative: '', widget: metricsWidget, projection: { columns: ['metric', 'value', 'unit'], rows: selectedMetrics.map(metric => [presentation.metricLabels?.[metric.id] ?? metric.label, metric.value, metric.unit]), status: 'ready', warnings: [], asOf: artifact.input.endDate, sourceIds: [sourceId] } });
    sections.push({ id: (0, finance_1.financeId)('section'), title: '가정과 방법', kind: 'sources', narrative: [artifact.method, ...artifact.assumptions, ...artifact.warnings, ...artifact.citations.map(c => `${c.title}\n${c.url}`), `input sha256: ${artifact.input.inputSha256}`].join('\n\n').slice(0, 20000), widget: null, projection: null });
    for (const input of artifact.inputEvidence ?? [])
        sections.push({ id: (0, finance_1.financeId)('section'), title: '계산 입력', kind: 'sources', narrative: input.sourceUrls.join('\n'), widget: null, projection: { columns: input.columns, rows: input.rows, status: input.status === 'ok' ? 'ready' : 'partial', warnings: input.warnings, asOf: input.asOf, sourceIds: [sourceId] } });
    if (presentation.highlightMetricIds?.some(id => !artifact.metrics.some(metric => metric.id === id)))
        throw new Error('finance_artifact_metric_not_found');
    if (presentation.narrative?.trim())
        sections.unshift({ id: (0, finance_1.financeId)('section'), title: title.slice(0, 300), kind: 'summary', presentation: 'narrative', narrative: presentation.narrative.slice(0, 20000), widget: null, projection: null });
    const report = { id: (0, finance_1.financeId)('report'), ...(language ? { language } : {}), title: title.slice(0, 300), createdAt: now, sourceRevision: workspace.revision, reviewPending: true, sections, dashboardSnapshot: null, parentReportId: null };
    operations.push({ type: 'report.add', report });
    return { operations, reportId: report.id, title: report.title, kind: 'chart' };
}
function financeConversationArtifact(results, workspace, title, kind, narrative, presentation = {}) {
    const language = presentation.language ? finance_1.FinanceReportLanguageSchema.parse(presentation.language) : undefined;
    const now = new Date().toISOString(), operations = [], sections = [];
    if (narrative.trim())
        sections.push({ id: (0, finance_1.financeId)('section'), title: title.slice(0, 300), kind: 'summary', presentation: 'narrative', narrative: narrative.slice(0, 20000), widget: null, projection: null });
    for (const [resultIndex, result] of results.entries()) {
        if (!['ok', 'partial'].includes(result.status) || !result.rows.length)
            continue;
        const url = result.sourceUrls.find(value => { try {
            const u = new URL(value);
            return u.protocol === 'https:' && !u.username && !u.password;
        }
        catch {
            return false;
        } });
        if (!url)
            throw new Error('finance_artifact_source_required');
        const sourceId = (0, finance_1.financeId)('source');
        operations.push({ type: 'source.upsert', source: { id: sourceId, name: new URL(url).hostname, kind: 'provider', status: 'connected', asOf: result.asOf, retrievedAt: result.retrievedAt, url, note: [...result.sourceUrls, ...result.warnings].join('\n').slice(0, 20000) } });
        const widget = (0, finance_1.createFinanceWidget)('chart', title);
        widget.width = 'full';
        widget.chartType = result.columns.includes('Close (raw)') || result.columns.includes('Par curve yield') ? 'line' : 'table';
        const chart = widget.chartType !== 'table', comparison = presentation.comparisonIndexes?.includes(resultIndex) ?? false;
        sections.push({ id: (0, finance_1.financeId)('section'), title, kind: chart || comparison ? 'widget' : 'sources', presentation: chart ? 'chart' : comparison ? 'comparison' : 'supporting', narrative: '', widget, projection: { columns: result.columns, rows: result.rows, status: result.status === 'ok' ? 'ready' : 'partial', warnings: result.warnings, asOf: result.asOf, sourceIds: [sourceId] } });
    }
    if (!sections.some(section => section.projection?.rows.length))
        throw new Error('finance_artifact_evidence_required');
    if (!sections.some(section => section.presentation !== 'supporting'))
        throw new Error('finance_artifact_visual_or_narrative_required');
    const report = { id: (0, finance_1.financeId)('report'), ...(language ? { language } : {}), title: title.slice(0, 300), createdAt: now, sourceRevision: workspace.revision, reviewPending: true, sections, dashboardSnapshot: null, parentReportId: null };
    operations.push({ type: 'report.add', report });
    return { operations, reportId: report.id, title: report.title, kind };
}


/***/ }),

/***/ 8348:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseUnionDef = exports.primitiveMappings = void 0;
const parseDef_js_1 = __webpack_require__(3524);
exports.primitiveMappings = {
    ZodString: "string",
    ZodNumber: "number",
    ZodBigInt: "integer",
    ZodBoolean: "boolean",
    ZodNull: "null",
};
function parseUnionDef(def, refs) {
    if (refs.target === "openApi3")
        return asAnyOf(def, refs);
    const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
    // This blocks tries to look ahead a bit to produce nicer looking schemas with type array instead of anyOf.
    if (options.every((x) => x._def.typeName in exports.primitiveMappings &&
        (!x._def.checks || !x._def.checks.length))) {
        // all types in union are primitive and lack checks, so might as well squash into {type: [...]}
        const types = options.reduce((types, x) => {
            const type = exports.primitiveMappings[x._def.typeName]; //Can be safely casted due to row 43
            return type && !types.includes(type) ? [...types, type] : types;
        }, []);
        return {
            type: types.length > 1 ? types : types[0],
        };
    }
    else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
        // all options literals
        const types = options.reduce((acc, x) => {
            const type = typeof x._def.value;
            switch (type) {
                case "string":
                case "number":
                case "boolean":
                    return [...acc, type];
                case "bigint":
                    return [...acc, "integer"];
                case "object":
                    if (x._def.value === null)
                        return [...acc, "null"];
                case "symbol":
                case "undefined":
                case "function":
                default:
                    return acc;
            }
        }, []);
        if (types.length === options.length) {
            // all the literals are primitive, as far as null can be considered primitive
            const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
            return {
                type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
                enum: options.reduce((acc, x) => {
                    return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
                }, []),
            };
        }
    }
    else if (options.every((x) => x._def.typeName === "ZodEnum")) {
        return {
            type: "string",
            enum: options.reduce((acc, x) => [
                ...acc,
                ...x._def.values.filter((x) => !acc.includes(x)),
            ], []),
        };
    }
    return asAnyOf(def, refs);
}
exports.parseUnionDef = parseUnionDef;
const asAnyOf = (def, refs) => {
    const anyOf = (def.options instanceof Map
        ? Array.from(def.options.values())
        : def.options)
        .map((x, i) => (0, parseDef_js_1.parseDef)(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "anyOf", `${i}`],
    }))
        .filter((x) => !!x &&
        (!refs.strictUnions ||
            (typeof x === "object" && Object.keys(x).length > 0)));
    return anyOf.length ? { anyOf } : undefined;
};


/***/ }),

/***/ 8385:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseEffectsDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const any_js_1 = __webpack_require__(2909);
function parseEffectsDef(_def, refs) {
    return refs.effectStrategy === "input"
        ? (0, parseDef_js_1.parseDef)(_def.schema._def, refs)
        : (0, any_js_1.parseAnyDef)(refs);
}
exports.parseEffectsDef = parseEffectsDef;


/***/ }),

/***/ 8598:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseArrayDef = void 0;
const v3_1 = __webpack_require__(9164);
const errorMessages_js_1 = __webpack_require__(8950);
const parseDef_js_1 = __webpack_require__(3524);
function parseArrayDef(def, refs) {
    const res = {
        type: "array",
    };
    if (def.type?._def &&
        def.type?._def?.typeName !== v3_1.ZodFirstPartyTypeKind.ZodAny) {
        res.items = (0, parseDef_js_1.parseDef)(def.type._def, {
            ...refs,
            currentPath: [...refs.currentPath, "items"],
        });
    }
    if (def.minLength) {
        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minItems", def.minLength.value, def.minLength.message, refs);
    }
    if (def.maxLength) {
        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maxItems", def.maxLength.value, def.maxLength.message, refs);
    }
    if (def.exactLength) {
        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "minItems", def.exactLength.value, def.exactLength.message, refs);
        (0, errorMessages_js_1.setResponseValueAndErrors)(res, "maxItems", def.exactLength.value, def.exactLength.message, refs);
    }
    return res;
}
exports.parseArrayDef = parseArrayDef;


/***/ }),

/***/ 8651:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ZodError = exports.quotelessJson = exports.ZodIssueCode = void 0;
const util_js_1 = __webpack_require__(2034);
exports.ZodIssueCode = util_js_1.util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite",
]);
const quotelessJson = (obj) => {
    const json = JSON.stringify(obj, null, 2);
    return json.replace(/"([^"]+)":/g, "$1:");
};
exports.quotelessJson = quotelessJson;
class ZodError extends Error {
    get errors() {
        return this.issues;
    }
    constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
            this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
            this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
            // eslint-disable-next-line ban/ban
            Object.setPrototypeOf(this, actualProto);
        }
        else {
            this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
    }
    format(_mapper) {
        const mapper = _mapper ||
            function (issue) {
                return issue.message;
            };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
            for (const issue of error.issues) {
                if (issue.code === "invalid_union") {
                    issue.unionErrors.map(processError);
                }
                else if (issue.code === "invalid_return_type") {
                    processError(issue.returnTypeError);
                }
                else if (issue.code === "invalid_arguments") {
                    processError(issue.argumentsError);
                }
                else if (issue.path.length === 0) {
                    fieldErrors._errors.push(mapper(issue));
                }
                else {
                    let curr = fieldErrors;
                    let i = 0;
                    while (i < issue.path.length) {
                        const el = issue.path[i];
                        const terminal = i === issue.path.length - 1;
                        if (!terminal) {
                            curr[el] = curr[el] || { _errors: [] };
                            // if (typeof el === "string") {
                            //   curr[el] = curr[el] || { _errors: [] };
                            // } else if (typeof el === "number") {
                            //   const errorArray: any = [];
                            //   errorArray._errors = [];
                            //   curr[el] = curr[el] || errorArray;
                            // }
                        }
                        else {
                            curr[el] = curr[el] || { _errors: [] };
                            curr[el]._errors.push(mapper(issue));
                        }
                        curr = curr[el];
                        i++;
                    }
                }
            }
        };
        processError(this);
        return fieldErrors;
    }
    static assert(value) {
        if (!(value instanceof ZodError)) {
            throw new Error(`Not a ZodError: ${value}`);
        }
    }
    toString() {
        return this.message;
    }
    get message() {
        return JSON.stringify(this.issues, util_js_1.util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
        return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
            if (sub.path.length > 0) {
                const firstEl = sub.path[0];
                fieldErrors[firstEl] = fieldErrors[firstEl] || [];
                fieldErrors[firstEl].push(mapper(sub));
            }
            else {
                formErrors.push(mapper(sub));
            }
        }
        return { formErrors, fieldErrors };
    }
    get formErrors() {
        return this.flatten();
    }
}
exports.ZodError = ZodError;
ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
};


/***/ }),

/***/ 8950:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.setResponseValueAndErrors = exports.addErrorMessage = void 0;
function addErrorMessage(res, key, errorMessage, refs) {
    if (!refs?.errorMessages)
        return;
    if (errorMessage) {
        res.errorMessage = {
            ...res.errorMessage,
            [key]: errorMessage,
        };
    }
}
exports.addErrorMessage = addErrorMessage;
function setResponseValueAndErrors(res, key, value, errorMessage, refs) {
    res[key] = value;
    addErrorMessage(res, key, errorMessage, refs);
}
exports.setResponseValueAndErrors = setResponseValueAndErrors;


/***/ }),

/***/ 9019:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.calculateFinance = calculateFinance;
const node_crypto_1 = __webpack_require__(7598);
const finance_compute_1 = __webpack_require__(5778);
const citations = {
    markowitz: { title: 'Markowitz (1952), Portfolio Selection', url: 'https://traders.berkeley.edu/papers/Markowitz.pdf' },
    riskParity: { title: 'Griveau-Billion, Richard & Roncalli (2013), Cyclical coordinate descent for risk parity', url: 'https://arxiv.org/abs/1311.4057' },
    shrinkage: { title: 'Ledoit & Wolf (2004), Covariance shrinkage background', url: 'https://www.ledoit.net/honey.pdf' },
    bootstrap: { title: 'Efron (1979), Bootstrap Methods: Another Look at the Jackknife', url: 'https://doi.org/10.1214/aos/1176344552' },
    merton: { title: 'Merton, Theory of Rational Option Pricing (MIT working paper)', url: 'https://dspace.mit.edu/entities/publication/6e05a2fa-478f-41e6-9e69-a06532002236' },
    option: { title: 'Black & Scholes (1973), The Pricing of Options and Corporate Liabilities', url: 'https://doi.org/10.1086/260062' },
};
function fail(code) { throw new Error(`finance_compute_${code}`); }
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const product = (a, x) => a.map(row => dot(row, x));
const metric = (id, label, value, unit) => ({ id, label, value, unit });
function canonical(value) { if (Array.isArray(value))
    return value.map(canonical); if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])); return value; }
/** A content identifier only, not proof that a provider or model actually ran. */
function digest(value) { return (0, node_crypto_1.createHash)('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function base(request, input) {
    return { schemaVersion: 1, engineVersion: 'finance-compute-v1', kind: request.kind, method: '', title: '', provenance: input.provenance,
        input: { symbols: [], assetIds: [], currency: '', startDate: null, endDate: null, observations: 0, inputSha256: digest({ request, input }) }, metrics: [], series: [], tables: [], assumptions: [], warnings: input.provenance.kind === 'scenario' ? ['가정 시나리오 · 관측된 시장자료가 아닙니다.'] : [], citations: [], diagnostics: { iterations: 0, converged: true, residual: 0 } };
}
function aligned(request, input) {
    if (new Set(input.histories.map(history => history.assetId)).size !== input.histories.length)
        fail('duplicate_history');
    const histories = request.assetIds.map(id => input.histories.find(history => history.assetId === id) ?? fail('history_missing'));
    const dates = histories[0].prices.map(point => point.date), currency = histories[0].currency, basis = histories[0].priceBasis;
    for (const history of histories) {
        if (history.currency !== currency)
            fail('currency_mismatch');
        if (history.priceBasis !== basis)
            fail('price_basis_mismatch');
        if (history.prices.length !== dates.length || history.prices.some((point, i) => point.date !== dates[i] || (i > 0 && point.date <= history.prices[i - 1].date)))
            fail('history_not_aligned');
    }
    const returns = dates.slice(1).map((_, t) => histories.map(history => history.prices[t + 1].close / history.prices[t].close - 1));
    if (returns.some(row => row.some(value => !Number.isFinite(value) || value <= -1 || Math.abs(value) > 10)))
        fail('return_out_of_range');
    return { histories, dates, currency, returns };
}
/** Projection onto the bounded unit simplex, without silently relaxing the user's bounds. */
function project(values, lower, upper) {
    if (values.length * lower > 1 + 1e-12 || values.length * upper < 1 - 1e-12 || lower > upper)
        fail('bounds_infeasible');
    let lo = Math.min(...values) - upper, hi = Math.max(...values) - lower;
    for (let i = 0; i < 90; i++) {
        const mid = (lo + hi) / 2, total = values.reduce((sum, value) => sum + Math.min(upper, Math.max(lower, value - mid)), 0);
        if (total > 1)
            lo = mid;
        else
            hi = mid;
    }
    return values.map(value => Math.min(upper, Math.max(lower, value - (lo + hi) / 2)));
}
function covariance(returns, shrinkage) {
    const n = returns[0].length, means = Array.from({ length: n }, (_, j) => returns.reduce((sum, row) => sum + row[j], 0) / returns.length);
    const sample = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => returns.reduce((sum, row) => sum + (row[i] - means[i]) * (row[j] - means[j]), 0) / (returns.length - 1)));
    if (sample.some((row, i) => row[i] < 1e-16))
        fail('constant_history');
    const scale = Math.max(...sample.map((row, i) => row[i])), ridge = scale * 1e-10;
    const regularized = sample.map((row, i) => row.map((value, j) => (i === j ? value : (1 - shrinkage) * value) + (i === j ? ridge : 0)));
    return { sample, regularized, means, ridge };
}
function minimumVariance(cov, lower, upper) {
    const scale = Math.max(...cov.map((row, i) => row[i])), a = cov.map(row => row.map(value => value / scale));
    const step = 1 / Math.max(...a.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
    let weights = project(Array(cov.length).fill(1 / cov.length), lower, upper), residual = Infinity;
    for (let iteration = 1; iteration <= 20000; iteration++) {
        const grad = product(a, weights), next = project(weights.map((weight, i) => weight - step * grad[i]), lower, upper);
        residual = Math.max(...next.map((weight, i) => Math.abs(weight - weights[i]))) / step;
        weights = next;
        if (residual < 1e-9)
            return { weights, iterations: iteration, residual };
    }
    return fail('solver_not_converged');
}
function riskParity(cov, lower, upper) {
    project(Array(cov.length).fill(1 / cov.length), lower, upper);
    const n = cov.length, scale = Math.max(...cov.map((row, i) => row[i])), a = cov.map(row => row.map(value => value / scale));
    const x = a.map((row, i) => 1 / Math.sqrt(n * row[i]));
    for (let iteration = 1; iteration <= 10000; iteration++) {
        for (let i = 0; i < n; i++) {
            const c = dot(a[i], x) - a[i][i] * x[i], root = Math.sqrt(c * c + 4 * a[i][i] / n);
            x[i] = c >= 0 ? (2 / n) / (root + c) : (root - c) / (2 * a[i][i]);
        }
        const total = x.reduce((sum, value) => sum + value, 0), weights = x.map(value => value / total), marginal = product(a, weights), variance = dot(weights, marginal);
        const residual = Math.max(...weights.map((weight, i) => Math.abs(weight * marginal[i] / variance - 1 / n)));
        if (!Number.isFinite(residual))
            fail('numeric_overflow');
        if (residual < 1e-8) {
            if (weights.some(weight => weight < lower - 1e-8 || weight > upper + 1e-8))
                fail('risk_parity_bounds_infeasible');
            return { weights, iterations: iteration, residual };
        }
    }
    return fail('solver_not_converged');
}
function allocation(request, input) {
    if (request.assetIds.length < 2)
        fail('allocation_requires_two_assets');
    const data = aligned(request, input), cov = covariance(data.returns, request.shrinkage);
    const solved = request.method === 'min_variance' ? minimumVariance(cov.regularized, request.minWeight, request.maxWeight) : riskParity(cov.regularized, request.minWeight, request.maxWeight);
    const { weights } = solved, result = base(request, input), marginal = product(cov.regularized, weights), variance = dot(weights, marginal), sampleVariance = dot(weights, product(cov.sample, weights));
    const violation = Math.max(Math.abs(weights.reduce((a, b) => a + b, 0) - 1), ...weights.map(weight => Math.max(0, request.minWeight - weight, weight - request.maxWeight)));
    if (violation > 1e-7)
        fail('bounds_infeasible');
    result.method = request.method;
    result.title = request.method === 'min_variance' ? '최소 분산 배분 · 과거자료 계산' : '동일 위험 기여 배분 · 과거자료 계산';
    Object.assign(result.input, { symbols: data.histories.map(h => h.symbol), assetIds: request.assetIds, currency: data.currency, startDate: data.dates[0], endDate: data.dates.at(-1), observations: data.returns.length });
    result.metrics = [metric('annualized_volatility', '정규화 공분산 연율 변동성', Math.sqrt(variance * request.periodsPerYear), 'fraction'), metric('sample_volatility', '표본 공분산 연율 변동성', Math.sqrt(sampleVariance * request.periodsPerYear), 'fraction'), metric('historical_mean', '과거 일평균 수익률의 연율 환산', dot(weights, cov.means) * request.periodsPerYear, 'fraction'), metric('constraint_violation', '최대 제약 위반', violation, 'weight')];
    result.series = [{ id: 'weights', label: '계산 비중', chart: 'bar', xLabel: '자산', yLabel: '비중', points: weights.map((weight, i) => ({ x: data.histories[i].symbol, y: weight })) }];
    result.tables = [{ id: 'allocation', title: '배분과 위험 기여', columns: ['assetId', 'symbol', 'weight', 'riskShare', 'annualizedVolatility'], rows: weights.map((weight, i) => [request.assetIds[i], data.histories[i].symbol, weight, weight * marginal[i] / variance, Math.sqrt(cov.regularized[i][i] * request.periodsPerYear)]) }, { id: 'covariance', title: '계산에 사용한 일별 공분산', columns: ['symbol', ...data.histories.map(h => h.symbol)], rows: cov.regularized.map((row, i) => [data.histories[i].symbol, ...row]) }];
    result.assumptions = [`단순 일별 수익률; 표본 분모 n−1; 연율 환산 ${request.periodsPerYear}개 관측/년.`, `공분산: 비대각 항에 1−${request.shrinkage}를 곱하는 고정 대각 수축 + 대각 ridge ${cov.ridge}. Ledoit–Wolf 최적 수축 추정량은 아닙니다.`, `공매도·레버리지 없음; 합계 1; 각 자산 비중 ${request.minWeight}–${request.maxWeight}.`, '동일 통화, 환헤지·세금·거래비용 제외. 과거 평균은 미래 기대수익 추정의 보장이 아닙니다.', '위험 기여는 정규화 공분산 기준이며, risk parity의 한도 충돌은 비중을 강제 조정하지 않고 거절합니다.'];
    if (data.histories.some(h => h.adjustment === 'unknown'))
        result.warnings.push('가격의 분할 조정 여부가 확인되지 않아 기업행사가 수익률과 위험을 왜곡할 수 있습니다.');
    if (data.histories[0].priceBasis === 'price')
        result.warnings.push('가격 수익률 기준: 배당을 포함한 총수익률이 아닙니다.');
    if (data.returns.length < 10 * request.assetIds.length)
        result.warnings.push('관측 수가 자산 수의 10배 미만입니다. 표본 공분산과 비중이 추정 오차에 민감할 수 있습니다.');
    result.citations = [citations.markowitz, citations.shrinkage, ...(request.method === 'risk_parity' ? [citations.riskParity] : [])];
    result.diagnostics = { iterations: solved.iterations, converged: true, residual: solved.residual };
    return result;
}
function random(seed) { let state = seed >>> 0; return () => { state = (state + 0x6D2B79F5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; }; }
function quantile(sorted, p) { const position = (sorted.length - 1) * p, left = Math.floor(position), alpha = position - left; return sorted[left] * (1 - alpha) + sorted[Math.min(left + 1, sorted.length - 1)] * alpha; }
function forecast(request, input) {
    const data = aligned(request, input), result = base(request, input), history = data.histories[0], spot = history.prices.at(-1).close, logReturns = data.returns.map(row => Math.log1p(row[0])), rng = random(request.seed), values = Array(request.paths).fill(spot);
    const points = [{ x: 0, y: spot, p05: spot, p25: spot, p50: spot, p75: spot, p95: spot }];
    for (let day = 1; day <= request.horizon; day++) {
        for (let p = 0; p < values.length; p++) {
            values[p] *= Math.exp(logReturns[Math.floor(rng() * logReturns.length)]);
            if (!Number.isFinite(values[p]) || values[p] > 1e15 || values[p] <= 0)
                fail('forecast_overflow');
        }
        const sorted = [...values].sort((a, b) => a - b), p50 = quantile(sorted, .5);
        points.push({ x: day, y: p50, p05: quantile(sorted, .05), p25: quantile(sorted, .25), p50, p75: quantile(sorted, .75), p95: quantile(sorted, .95) });
    }
    const last = points.at(-1);
    result.method = 'historical_iid_bootstrap';
    result.title = '과거 수익률 재표본 시나리오';
    Object.assign(result.input, { symbols: [history.symbol], assetIds: request.assetIds, currency: data.currency, startDate: data.dates[0], endDate: data.dates.at(-1), observations: data.returns.length });
    result.metrics = [metric('initial', '시작값', spot, data.currency), metric('terminal_median', '마지막 단계 중앙값', last.p50, data.currency), metric('terminal_p05', '마지막 단계 5분위', last.p05, data.currency), metric('terminal_p95', '마지막 단계 95분위', last.p95, data.currency)];
    result.series = [{ id: 'forecast', label: '5·25·50·75·95 분위 경로', chart: 'fan', xLabel: '앞으로의 관측 단계', yLabel: data.currency, points }];
    result.tables = [{ id: 'fan', title: '단계별 분위', columns: ['step', 'p05', 'p25', 'p50', 'p75', 'p95'], rows: points.map(p => [p.x, p.p05, p.p25, p.p50, p.p75, p.p95]) }];
    result.assumptions = [`과거 로그수익률을 독립·동일분포로 복원 추출합니다. ${request.paths}개 경로, ${request.horizon}개 관측 단계, seed ${request.seed}.`, '난수 알고리즘 mulberry32; 분위는 정렬 표본 사이 선형 보간. 시계열 순서·변동성 군집·구조 변화는 반영하지 않습니다.', '밴드는 조건부 시나리오 분위이며 예측 정확도나 미래 가격의 보장·검증된 신뢰구간이 아닙니다.', '주말·휴장일을 예측 날짜로 만들지 않고 단계 번호를 표시합니다. 거래비용·세금 제외.'];
    if (history.adjustment === 'unknown')
        result.warnings.push('분할 조정 여부가 불명확하여 기업행사에 의한 가격 변화가 재표본될 수 있습니다.');
    if (history.priceBasis === 'price')
        result.warnings.push('배당을 포함하지 않는 가격 기준 시나리오입니다.');
    result.citations = [citations.bootstrap];
    result.diagnostics = { iterations: request.horizon, converged: true, residual: 0, seed: request.seed, paths: request.paths };
    return result;
}
/** Normal CDF approximation, absolute error below about 8e-8 in the central region. */
function normal(x) { if (x === 0)
    return .5; const a = Math.abs(x), t = 1 / (1 + .2316419 * a), density = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI), tail = density * t * (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - tail : tail; }
function option(request, input) {
    if (input.provenance.kind !== 'scenario' || input.histories.length)
        fail('option_requires_scenario');
    const { spot: s, strike: k, rate: r, dividendYield: q, volatility: v, years: t } = request, sqrt = Math.sqrt(t), d1 = (Math.log(s / k) + (r - q + v * v / 2) * t) / (v * sqrt), d2 = d1 - v * sqrt, discountR = Math.exp(-r * t), discountQ = Math.exp(-q * t), phi = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI), call = request.optionType === 'call';
    const price = call ? s * discountQ * normal(d1) - k * discountR * normal(d2) : k * discountR * normal(-d2) - s * discountQ * normal(-d1);
    const delta = call ? discountQ * normal(d1) : discountQ * (normal(d1) - 1), gamma = discountQ * phi / (s * v * sqrt), vega = s * discountQ * phi * sqrt;
    const theta = -s * discountQ * phi * v / (2 * sqrt) + (call ? q * s * discountQ * normal(d1) - r * k * discountR * normal(d2) : r * k * discountR * normal(-d2) - q * s * discountQ * normal(-d1));
    const rho = call ? k * t * discountR * normal(d2) : -k * t * discountR * normal(-d2), result = base(request, input);
    result.method = 'black_scholes_merton_european';
    result.title = `유럽형 ${call ? '콜' : '풋'} 옵션 · 가정 시나리오`;
    Object.assign(result.input, { symbols: [request.symbol], currency: request.currency, observations: 0 });
    result.metrics = [metric('price', '이론 가격', Math.max(0, price), request.currency), metric('delta', 'Delta', delta, 'per spot unit'), metric('gamma', 'Gamma', gamma, 'per spot unit squared'), metric('vega', 'Vega · 변동성 1%p', vega / 100, request.currency), metric('theta', 'Theta · 달력 1일', theta / 365, request.currency), metric('rho', 'Rho · 금리 1%p', rho / 100, request.currency)];
    const grid = [...new Set([0, s, k, ...Array.from({ length: 81 }, (_, i) => Math.max(s, k) * 2 * i / 80)])].sort((a, b) => a - b), points = grid.map(terminal => { const payoff = Math.max(call ? terminal - k : k - terminal, 0); return { terminal, payoff, pnl: payoff - Math.max(0, price) }; });
    result.series = [{ id: 'payoff', label: '만기 지급액', chart: 'line', xLabel: '만기 기초자산 가격', yLabel: request.currency, points: points.map(p => ({ x: p.terminal, y: p.payoff })) }, { id: 'pnl', label: '만기 지급액 − 현재 프리미엄', chart: 'line', xLabel: '만기 기초자산 가격', yLabel: request.currency, points: points.map(p => ({ x: p.terminal, y: p.pnl })) }];
    result.tables = [{ id: 'parameters', title: '가정 입력값', columns: ['parameter', 'value', 'unit'], rows: [['spot', s, request.currency], ['strike', k, request.currency], ['rate', r, 'annual continuously compounded fraction'], ['dividendYield', q, 'continuous annual fraction'], ['volatility', v, 'annual fraction'], ['years', t, 'years'], ['origin', input.provenance.origin, 'scenario']] }, { id: 'payoff', title: '만기 시나리오', columns: ['terminalSpot', 'payoff', 'payoffLessPremium'], rows: points.map(p => [p.terminal, p.payoff, p.pnl]) }];
    result.assumptions = ['유럽형·만기 행사; 일정 연율 변동성·연속복리 금리·연속 배당수익률의 Black–Scholes–Merton 모형.', '기초자산 1단위 기준; 계약 승수는 적용하지 않습니다. 옵션 시장 호가·실현 가격이 아닌 가정 입력값의 이론 계산입니다. 미국형 조기 행사·변동성 스마일·거래비용 제외.', '만기 순액은 지급액에서 현재 프리미엄만 차감합니다. 프리미엄 조달 이자와 세금은 제외합니다.', 'Vega/Rho는 각각 1%p 변화, Theta는 달력 1일 경과 단위. 만기 0/변동성 0의 미분 불능 경계는 허용하지 않습니다.'];
    result.citations = [citations.option, citations.merton];
    return result;
}
/** Deterministic host calculation. Never fetches, saves, places trades or invokes a model. */
function calculateFinance(rawRequest, rawInput) {
    const request = finance_compute_1.FinanceComputeRequestSchema.parse(rawRequest), input = finance_compute_1.FinanceComputeInputSchema.parse(rawInput);
    const result = request.kind === 'allocation' ? allocation(request, input) : request.kind === 'forecast' ? forecast(request, input) : option(request, input);
    const check = (value) => { if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e15))
        fail('numeric_overflow'); if (Array.isArray(value))
        value.forEach(check);
    else if (value && typeof value === 'object')
        Object.values(value).forEach(check); };
    check(result);
    return result;
}


/***/ }),

/***/ 9137:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseMapDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const record_js_1 = __webpack_require__(7054);
const any_js_1 = __webpack_require__(2909);
function parseMapDef(def, refs) {
    if (refs.mapStrategy === "record") {
        return (0, record_js_1.parseRecordDef)(def, refs);
    }
    const keys = (0, parseDef_js_1.parseDef)(def.keyType._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", "items", "0"],
    }) || (0, any_js_1.parseAnyDef)(refs);
    const values = (0, parseDef_js_1.parseDef)(def.valueType._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", "items", "1"],
    }) || (0, any_js_1.parseAnyDef)(refs);
    return {
        type: "array",
        maxItems: 125,
        items: {
            type: "array",
            items: [keys, values],
            minItems: 2,
            maxItems: 2,
        },
    };
}
exports.parseMapDef = parseMapDef;


/***/ }),

/***/ 9164:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.z = void 0;
const z = __importStar(__webpack_require__(9325));
exports.z = z;
__exportStar(__webpack_require__(9325), exports);
exports["default"] = z;


/***/ }),

/***/ 9225:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parsePipelineDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const parsePipelineDef = (def, refs) => {
    if (refs.pipeStrategy === "input") {
        return (0, parseDef_js_1.parseDef)(def.in._def, refs);
    }
    else if (refs.pipeStrategy === "output") {
        return (0, parseDef_js_1.parseDef)(def.out._def, refs);
    }
    const a = (0, parseDef_js_1.parseDef)(def.in._def, {
        ...refs,
        currentPath: [...refs.currentPath, "allOf", "0"],
    });
    const b = (0, parseDef_js_1.parseDef)(def.out._def, {
        ...refs,
        currentPath: [...refs.currentPath, "allOf", a ? "1" : "0"],
    });
    return {
        allOf: [a, b].filter((x) => x !== undefined),
    };
};
exports.parsePipelineDef = parsePipelineDef;


/***/ }),

/***/ 9317:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.defaultErrorMap = void 0;
exports.setErrorMap = setErrorMap;
exports.getErrorMap = getErrorMap;
const en_js_1 = __importDefault(__webpack_require__(5653));
exports.defaultErrorMap = en_js_1.default;
let overrideErrorMap = en_js_1.default;
function setErrorMap(map) {
    overrideErrorMap = map;
}
function getErrorMap() {
    return overrideErrorMap;
}


/***/ }),

/***/ 9325:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
__exportStar(__webpack_require__(9317), exports);
__exportStar(__webpack_require__(819), exports);
__exportStar(__webpack_require__(6370), exports);
__exportStar(__webpack_require__(2034), exports);
__exportStar(__webpack_require__(491), exports);
__exportStar(__webpack_require__(8651), exports);


/***/ }),

/***/ 9340:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
__exportStar(__webpack_require__(2626), exports);
__exportStar(__webpack_require__(1076), exports);
__exportStar(__webpack_require__(8950), exports);
__exportStar(__webpack_require__(6379), exports);
__exportStar(__webpack_require__(3524), exports);
__exportStar(__webpack_require__(802), exports);
__exportStar(__webpack_require__(2909), exports);
__exportStar(__webpack_require__(8598), exports);
__exportStar(__webpack_require__(7236), exports);
__exportStar(__webpack_require__(8147), exports);
__exportStar(__webpack_require__(6163), exports);
__exportStar(__webpack_require__(6260), exports);
__exportStar(__webpack_require__(5187), exports);
__exportStar(__webpack_require__(9606), exports);
__exportStar(__webpack_require__(8385), exports);
__exportStar(__webpack_require__(6750), exports);
__exportStar(__webpack_require__(686), exports);
__exportStar(__webpack_require__(4836), exports);
__exportStar(__webpack_require__(9137), exports);
__exportStar(__webpack_require__(6773), exports);
__exportStar(__webpack_require__(3237), exports);
__exportStar(__webpack_require__(7294), exports);
__exportStar(__webpack_require__(1854), exports);
__exportStar(__webpack_require__(1114), exports);
__exportStar(__webpack_require__(6172), exports);
__exportStar(__webpack_require__(5867), exports);
__exportStar(__webpack_require__(9225), exports);
__exportStar(__webpack_require__(3858), exports);
__exportStar(__webpack_require__(9729), exports);
__exportStar(__webpack_require__(7054), exports);
__exportStar(__webpack_require__(4519), exports);
__exportStar(__webpack_require__(3178), exports);
__exportStar(__webpack_require__(2793), exports);
__exportStar(__webpack_require__(7987), exports);
__exportStar(__webpack_require__(8348), exports);
__exportStar(__webpack_require__(5973), exports);
__exportStar(__webpack_require__(2465), exports);
__exportStar(__webpack_require__(4633), exports);
const zodToJsonSchema_js_1 = __webpack_require__(4633);
exports["default"] = zodToJsonSchema_js_1.zodToJsonSchema;


/***/ }),

/***/ 9405:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.runFinancePlanning = runFinancePlanning;
const node_crypto_1 = __webpack_require__(7598);
const finance_planning_1 = __webpack_require__(4158);
const SCALE = 1000000n, RATE = 1000000000000n, LIMIT = 1000000000000000n * SCALE;
function fail(code) { throw new Error(`finance_planning_${code}`); }
function roundDiv(value, denominator) { if (denominator <= 0n)
    fail('numeric_invalid'); const negative = value < 0n, n = negative ? -value : value, q = n / denominator, r = n % denominator; const rounded = q + (r * 2n > denominator || r * 2n === denominator && q % 2n === 1n ? 1n : 0n); return negative ? -rounded : rounded; }
const quantum = (precision) => 10n ** BigInt(6 - precision);
function money(value, precision) { const [a, b = ''] = value.split('.'); const result = BigInt(a) * SCALE + BigInt(b.padEnd(6, '0')); if (result % quantum(precision) !== 0n)
    fail('money_precision_mismatch'); return result; }
function rounded(value, precision) { if (value < 0n || value > LIMIT)
    fail('numeric_range'); const q = quantum(precision); return roundDiv(value, q) * q; }
function multiply(value, factor, precision) { if (!Number.isFinite(factor) || factor < 0 || factor > 1e6)
    fail('numeric_range'); return rounded(roundDiv(value * BigInt(Math.round(factor * Number(RATE))), RATE), precision); }
function text(value, precision) { value = rounded(value, precision); const a = value / SCALE, b = (value % SCALE).toString().padStart(6, '0').slice(0, precision); return precision ? `${a}.${b}` : `${a}`; }
const total = (values) => values.reduce((a, b) => a + b, 0n);
const metric = (id, label, value, unit) => ({ id, label, value, unit });
function base(request) { return { schemaVersion: 1, engineVersion: 'finance-planning-v1', kind: request.kind, status: 'ok', currency: request.currency, precision: request.precision, asOf: request.asOf, inputSha256: (0, node_crypto_1.createHash)('sha256').update(JSON.stringify(request)).digest('hex'), summary: '', metrics: [], monthlyProjection: [], annualProjection: [], trades: [], charts: [], assumptions: [`Explicit ${request.assumptionOrigin} scenario; no market return, distribution, tax or plan rule is inferred.`, `All amounts are ${request.currency}; no implicit FX conversion. Monetary results use half-even rounding to ${request.precision} decimal places.`, ...request.assumptionNotes], warnings: ['Deterministic scenario, not a probability of success or a guaranteed outcome.'], errors: [], request }; }
function cashflow(request, result) {
    const p = request.precision, initial = money(request.initialCapital, p), contribution = money(request.monthlyContribution, p), income = money(request.monthlyIncome, p), withdrawal = money(request.monthlyWithdrawal, p), target = request.targetEndBalance === undefined ? null : money(request.targetEndBalance, p), growth = (1 + request.annualReturn) ** (1 / 12), inflation = 1 + request.annualInflation;
    const simulate = (monthly, collect) => {
        let balance = initial, shortfall = 0n, feesTotal = 0n, depleted = null;
        const points = [];
        if (collect)
            points.push({ month: 0, balance: text(initial, p), realBalance: text(initial, p), contribution: text(0n, p), income: text(0n, p), withdrawalRequested: text(0n, p), withdrawalPaid: text(0n, p), fees: text(0n, p), shortfall: text(0n, p) });
        for (let month = 1; month <= request.months; month++) {
            const grown = multiply(balance, growth, p), fees = multiply(grown, request.annualFeeRate / 12, p), requested = request.withdrawalInflationAdjusted ? multiply(withdrawal, inflation ** ((month - 1) / 12), p) : withdrawal;
            const available = rounded(grown - fees + monthly + income, p), paid = requested < available ? requested : available, missing = requested - paid;
            balance = available - paid;
            shortfall += missing;
            feesTotal += fees;
            if (missing > 0n && depleted === null)
                depleted = month;
            if (collect)
                points.push({ month, balance: text(balance, p), realBalance: text(multiply(balance, 1 / (inflation ** (month / 12)), p), p), contribution: text(monthly, p), income: text(income, p), withdrawalRequested: text(requested, p), withdrawalPaid: text(paid, p), fees: text(fees, p), shortfall: text(missing, p) });
        }
        return { end: balance, shortfall, points, depleted, fees: feesTotal };
    };
    const simulation = simulate(contribution, true);
    result.monthlyProjection = simulation.points;
    for (let start = 1; start <= request.months; start += 12) {
        const group = simulation.points.slice(start, Math.min(start + 12, request.months + 1)), last = group[group.length - 1];
        const summed = (key) => text(total(group.map(point => money(String(point[key]), p))), p);
        result.annualProjection.push({ ...last, contribution: summed('contribution'), income: summed('income'), withdrawalRequested: summed('withdrawalRequested'), withdrawalPaid: summed('withdrawalPaid'), fees: summed('fees'), shortfall: summed('shortfall') });
    }
    result.metrics = [metric('ending_balance', 'Ending balance', text(simulation.end, p), 'money'), metric('ending_real_balance', 'Ending balance in starting purchasing power', simulation.points.at(-1).realBalance, 'money'), metric('unfunded_withdrawals', 'Unfunded withdrawals', text(simulation.shortfall, p), 'money'), metric('depletion_month', 'First unfunded withdrawal month', simulation.depleted, 'month'), metric('total_fees', 'Additional fees', text(simulation.fees, p), 'money')];
    if (target !== null) {
        const maximumMonthly = 1000000000000n * SCALE - quantum(p);
        let lo = 0n, hi = quantum(p);
        const succeeds = (amount) => { const s = simulate(amount, false); return s.end >= target && s.shortfall === 0n; };
        while (!succeeds(hi) && hi < maximumMonthly)
            hi = hi * 2n > maximumMonthly ? maximumMonthly : hi * 2n;
        if (!succeeds(hi))
            result.warnings.push('Target cannot be reached within the supported monthly-contribution bound.');
        else {
            const q = quantum(p);
            while (hi - lo > q) {
                const mid = ((lo + hi) / 2n / q) * q;
                if (succeeds(mid))
                    hi = mid;
                else
                    lo = mid + q;
            }
            const answer = succeeds(lo) ? lo : hi;
            result.metrics.push(metric('required_monthly_contribution', 'Total monthly contribution required for target', text(answer, p), 'money'));
        }
        result.metrics.push(metric('target_end_balance', 'Target ending balance', text(target, p), 'money'));
    }
    if (simulation.shortfall > 0n) {
        result.status = 'infeasible';
        result.errors.push({ code: 'finance_planning_cashflow_shortfall', detail: 'Requested withdrawals exceed available assets in at least one month.' });
    }
    const chart = request.months > 120 ? [simulation.points[0], ...result.annualProjection] : simulation.points;
    result.charts = [{ id: 'balance', label: 'Projected balance', type: 'line', points: chart.map(point => ({ x: point.month, y: Number(point.balance) })) }];
    result.summary = simulation.shortfall > 0n ? 'The stated withdrawals create a funding shortfall.' : 'The stated cash flows remain funded over the selected horizon.';
    result.assumptions.push('Annual return is an effective nominal total return. Its monthly factor is (1 + annualReturn)^(1/12). Additional fees are annualFeeRate/12 of the balance after growth.', 'Contributions and other income arrive at month end before the requested withdrawal; no borrowing is assumed. No separate dividend income is added to total return.', 'Real balances use the stated inflation assumption. Only withdrawals grow with inflation when explicitly enabled. The first month uses the stated initial withdrawal.');
}
function incomeGoal(request, result) {
    const p = request.precision, capital = money(request.capital, p), target = money(request.monthlyIncomeTarget, p), other = money(request.otherMonthlyIncome, p), need = target > other ? target - other : 0n, netYield = request.annualCashYield * (1 - request.withholdingRate) - request.annualFeeRate;
    const annualGross = multiply(capital, request.annualCashYield, p), withheld = multiply(annualGross, request.withholdingRate, p), fees = multiply(capital, request.annualFeeRate, p), netAnnual = annualGross - withheld - fees, netMonthly = roundDiv(netAnnual, 12n * quantum(p)) * quantum(p), covered = netMonthly + other, shortfall = target > covered ? target - covered : 0n;
    let required = need === 0n ? text(0n, p) : null;
    if (need > 0n && netYield > 0) {
        const rate = BigInt(Math.round(netYield * Number(RATE)));
        if (rate <= 0n)
            fail('net_yield_nonpositive');
        const q = quantum(p), n = need * 12n * RATE;
        required = text(((n + rate * q - 1n) / (rate * q)) * q, p);
    }
    if (need > 0n && netYield <= 0) {
        result.status = 'infeasible';
        result.errors.push({ code: 'finance_planning_net_yield_nonpositive' });
    }
    if (shortfall > 0n) {
        result.status = 'infeasible';
        result.errors.push({ code: 'finance_planning_income_shortfall' });
    }
    result.metrics = [metric('net_yield', 'Assumed cash yield after stated withholding and additional fees', netYield, 'fraction'), metric('monthly_investment_income', 'Estimated monthly investment cash income', (netMonthly < 0n ? '-' + text(-netMonthly, p) : text(netMonthly, p)), 'money'), metric('monthly_shortfall', 'Monthly income shortfall', text(shortfall, p), 'money'), metric('required_capital', 'Capital required under stated yield', required, 'money'), metric('annual_fee', 'Additional annual fees', text(fees, p), 'money')];
    result.charts = [{ id: 'income', label: 'Monthly income', type: 'bar', points: [{ x: 'Investment income', y: Number((netMonthly < 0n ? '-' + text(-netMonthly, p) : text(netMonthly, p))) }, { x: 'Other income', y: Number(text(other, p)) }, { x: 'Income target', y: Number(text(target, p)) }] }];
    result.summary = required === null ? 'The stated net cash yield cannot fund the income goal.' : shortfall > 0n ? 'The stated capital and cash yield leave an income shortfall.' : 'The stated income sources cover the goal under these assumptions.';
    result.assumptions.push('Cash yield is an explicit gross annual distribution assumption, not price appreciation or a guaranteed distribution. Withholding is a user/model rate assumption, not a legal tax determination.', 'Additional fees are deducted once from the stated cash yield. Required capital is rounded upward to the chosen monetary precision. Capital preservation and market-price changes are not modeled.');
    if (netAnnual < 0n)
        result.warnings.push('Additional fees exceed the after-withholding distribution; the negative investment cash flow is retained; capital-price changes are not modeled.');
}
function rebalance(request, result) {
    const p = request.precision, fmt = (x) => text(x, p), q = quantum(p);
    const reject = (code, field) => result.errors.push({ code: `finance_planning_${code}`, ...(field ? { field } : {}) });
    const unique = (values, field) => { if (new Set(values).size !== values.length)
        reject('duplicate_id', field); };
    unique(request.planMenu.map(x => x.id), 'planMenu');
    if (new Set(request.planMenu.map(x => x.label)).size !== request.planMenu.length)
        reject('ambiguous_instrument_labels', 'planMenu');
    unique(request.positions.map(x => x.instrumentId), 'positions');
    unique(request.targetWeights.map(x => x.instrumentId), 'targetWeights');
    unique(request.constraints.lockedIds, 'lockedIds');
    unique(request.constraints.excludedIds, 'excludedIds');
    unique(request.constraints.bounds.map(x => x.instrumentId), 'bounds');
    if (!request.menuConfirmed)
        result.warnings.push('The supplied instrument menu and trading permissions are unverified scenario inputs.');
    if (request.constraints.maxRiskWeight === undefined)
        result.warnings.push('No risk cap was supplied; compliance with external account risk limits has not been checked.');
    const menu = new Map(request.planMenu.map(x => [x.id, x])), current = new Map(request.positions.map(x => [x.instrumentId, money(x.currentValue, p)])), targets = new Map(request.targetWeights.map(x => [x.instrumentId, x.weight]));
    for (const id of [...current.keys(), ...targets.keys(), ...request.constraints.lockedIds, ...request.constraints.excludedIds, ...request.constraints.bounds.map(x => x.instrumentId)])
        if (!menu.has(id))
            reject('instrument_not_in_plan_menu', id);
    for (const id of current.keys())
        if (!targets.has(id))
            reject('target_missing_for_position', id);
    for (const id of [...request.constraints.lockedIds, ...request.constraints.excludedIds, ...request.constraints.bounds.map(x => x.instrumentId)])
        if (!targets.has(id))
            reject('constraint_target_missing', id);
    if (Math.abs(totalWeight(request.targetWeights) - 1) > 1e-9)
        reject('target_weights_must_sum_one');
    const cash = money(request.cash, p), contribution = money(request.contribution, p), reserve = money(request.reserve, p), feeReserve = money(request.feeReserve, p), capital = total([...current.values()]) + cash + contribution, investable = capital - reserve - feeReserve;
    if (investable < 0n)
        reject('reserve_exceeds_capital');
    if (result.errors.length) {
        result.status = 'infeasible';
        result.summary = 'The stated plan or allocation constraints cannot be applied.';
        return;
    }
    let feeTotal = 0n, bought = 0n, sold = 0n, risky = 0n, unknownRisk = false;
    const fixed = money(request.fees.fixedPerTrade, p);
    for (const target of request.targetWeights) {
        const instrument = menu.get(target.instrumentId), old = current.get(target.instrumentId) ?? 0n, value = investable * BigInt(Math.round(target.weight * Number(RATE))) / RATE / q * q, delta = value - old, amount = delta < 0n ? -delta : delta;
        const fee = amount === 0n ? 0n : fixed + multiply(amount, request.fees.proportionalRate, p);
        feeTotal += fee;
        if (delta > 0n)
            bought += delta;
        else
            sold -= delta;
        if (delta > 0n && !instrument.buyAllowed)
            reject('buy_not_allowed', target.instrumentId);
        if (delta < 0n && !instrument.sellAllowed)
            reject('sell_not_allowed', target.instrumentId);
        if (request.constraints.lockedIds.includes(target.instrumentId) && delta !== 0n)
            reject('locked_position_changed', target.instrumentId);
        if (request.constraints.excludedIds.includes(target.instrumentId) && value !== 0n)
            reject('excluded_instrument_target', target.instrumentId);
        const bound = request.constraints.bounds.find(x => x.instrumentId === target.instrumentId);
        if (bound && (bound.minWeight > bound.maxWeight || target.weight < bound.minWeight - 1e-10 || target.weight > bound.maxWeight + 1e-10))
            reject('weight_bound_violated', target.instrumentId);
        if (instrument.riskClass === 'risk')
            risky += value;
        else if (instrument.riskClass === 'unknown' && value > 0n) {
            unknownRisk = true;
            if (request.constraints.maxRiskWeight !== undefined)
                reject('risk_classification_required', target.instrumentId);
        }
        result.trades.push({ instrumentId: target.instrumentId, label: instrument.label, side: delta > 0n ? 'buy' : delta < 0n ? 'sell' : 'hold', currentValue: fmt(old), targetValue: fmt(value), amount: fmt(amount), estimatedFee: fmt(fee), targetWeight: target.weight });
    }
    const cashAfter = cash + contribution + sold - bought - feeTotal, postFeeCapital = capital - feeTotal;
    if (feeTotal > feeReserve)
        reject('fee_reserve_insufficient');
    if (cashAfter < reserve)
        reject('cash_reserve_violated');
    const riskWeight = postFeeCapital > 0n ? Number(risky) / Number(postFeeCapital) : 0;
    if (request.constraints.maxRiskWeight !== undefined && riskWeight > request.constraints.maxRiskWeight + 1e-10)
        reject('risk_cap_violated');
    result.metrics = [metric('capital_before', 'Capital including contribution', fmt(capital), 'money'), metric('estimated_fees', 'Estimated transaction fees', fmt(feeTotal), 'money'), metric('cash_after', 'Cash after suggested trades', cashAfter < 0n ? null : fmt(cashAfter), 'money'), metric('risk_weight', 'Post-fee risky allocation including cash reserve', unknownRisk ? null : riskWeight, 'fraction')];
    if (unknownRisk)
        result.warnings.push('Some target holdings have unknown risk classification; aggregate risky allocation is unavailable.');
    result.status = result.errors.length ? 'infeasible' : 'ok';
    result.summary = result.errors.length ? 'The suggested allocation violates the stated constraints.' : 'The target allocation satisfies the stated input constraints after fees and reserves.';
    if (!result.errors.length)
        result.charts = [{ id: 'targets', label: 'Target holding values', type: 'bar', points: result.trades.map(t => ({ x: t.label, y: Number(t.targetValue) })) }];
    result.assumptions.push('One account and one declared currency per calculation. Plan menu and risk classifications are supplied inputs, not inferred regulatory facts.', 'Target weights sum to one across investable assets after deducting reserve and feeReserve. Target amounts are rounded down to the chosen monetary precision; the remainder stays in cash.', 'Bounds apply to the stated investable target weights. Risk cap applies to risk-classified target value divided by post-transaction-fee total account capital, including cash reserves.', 'Locked positions must retain their exact input value. Exclusions require zero target. Missing current-position targets are rejected instead of silently liquidated.', 'Trade amounts are value suggestions, not share quantities or executable orders; taxes, spreads and unavailable restrictions are not inferred.');
    result.warnings.push('Passing the supplied constraints is not a legal determination of pension or plan eligibility. No trade is executed.');
}
function totalWeight(weights) { return weights.reduce((a, b) => a + b.weight, 0); }
/** Pure bounded scenario calculation: no providers, storage, account access, model calls or order execution. */
function runFinancePlanning(raw) {
    const request = finance_planning_1.FinancePlanningRequestSchema.parse(raw), result = base(request);
    try {
        if (request.kind === 'cashflow')
            cashflow(request, result);
        else if (request.kind === 'income_goal')
            incomeGoal(request, result);
        else
            rebalance(request, result);
    }
    catch (error) {
        if (!(error instanceof Error) || !/^finance_planning_[a-z_]+$/.test(error.message))
            throw error;
        result.status = 'infeasible';
        result.errors.push({ code: error.message });
        result.summary = 'The scenario cannot be calculated with the stated inputs.';
        result.charts = [];
        result.trades = [];
        result.monthlyProjection = [];
        result.annualProjection = [];
    }
    return result;
}


/***/ }),

/***/ 9544:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FinanceAnalystRequestSchema = exports.FinanceAnalystSchema = exports.FinanceAnalystRefsSchema = exports.FinanceAnalystRefSchema = exports.FinanceAnalystRevisionSchema = exports.FinanceAnalystIdSchema = exports.FinanceAnalystDraftSchema = exports.FINANCE_ANALYST_LIMITS = exports.FINANCE_ANALYST_BUILTIN_IDS = void 0;
const zod_1 = __webpack_require__(7552);
exports.FINANCE_ANALYST_BUILTIN_IDS = ['builtin:value', 'builtin:growth', 'builtin:income', 'builtin:etf'];
exports.FINANCE_ANALYST_LIMITS = { custom: 100, selected: 3 };
const singleLine = (max) => zod_1.z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Expected a nonempty single line');
exports.FinanceAnalystDraftSchema = zod_1.z.object({
    name: singleLine(80), description: singleLine(240),
    instructions: zod_1.z.string().min(1).max(12000).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected skill instructions'),
}).strict();
exports.FinanceAnalystIdSchema = zod_1.z.union([zod_1.z.enum(exports.FINANCE_ANALYST_BUILTIN_IDS), zod_1.z.string().regex(/^custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)]);
exports.FinanceAnalystRevisionSchema = zod_1.z.string().regex(/^[a-f0-9]{64}$/);
exports.FinanceAnalystRefSchema = zod_1.z.object({ id: exports.FinanceAnalystIdSchema, revision: exports.FinanceAnalystRevisionSchema }).strict();
exports.FinanceAnalystRefsSchema = zod_1.z.array(exports.FinanceAnalystRefSchema).max(exports.FINANCE_ANALYST_LIMITS.selected).refine(refs => new Set(refs.map(ref => ref.id)).size === refs.length, 'Duplicate analyst references');
exports.FinanceAnalystSchema = exports.FinanceAnalystDraftSchema.extend({ id: exports.FinanceAnalystIdSchema, revision: exports.FinanceAnalystRevisionSchema, origin: zod_1.z.enum(['builtin', 'custom']) }).strict();
exports.FinanceAnalystRequestSchema = zod_1.z.discriminatedUnion('action', [
    zod_1.z.object({ action: zod_1.z.literal('list') }).strict(),
    zod_1.z.object({ action: zod_1.z.literal('save'), draft: exports.FinanceAnalystDraftSchema, id: exports.FinanceAnalystIdSchema.optional(), expectedRevision: exports.FinanceAnalystRevisionSchema.optional() }).strict(),
    zod_1.z.object({ action: zod_1.z.literal('remove'), id: exports.FinanceAnalystIdSchema, expectedRevision: exports.FinanceAnalystRevisionSchema }).strict(),
]).superRefine((request, context) => {
    if (request.action === 'save' && (request.id === undefined) !== (request.expectedRevision === undefined))
        context.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'Update requires id and expectedRevision; create requires neither' });
});


/***/ }),

/***/ 9568:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.financePortfolioValuation = financePortfolioValuation;
exports.financePortfolioValuationArtifact = financePortfolioValuationArtifact;
const finance_1 = __webpack_require__(726);
const VALUE_LIMIT = 1e15;
const common = (values) => values.length && values[0] && values.every(v => v === values[0]) ? values[0] : null;
const bounded = (value) => Number.isFinite(value) && value >= 0 && value <= VALUE_LIMIT;
/** A read-only observed snapshot. Existing workspace quotes and cost bases are deliberately never consulted. */
function financePortfolioValuation(workspace, refreshResult) {
    const ws = (0, finance_1.validateFinanceWorkspace)(workspace);
    if (refreshResult.baseRevision !== ws.revision)
        throw new Error('finance_portfolio_refresh_revision_conflict');
    if (!['ok', 'unavailable', undefined].includes(refreshResult.status))
        throw new Error('finance_portfolio_refresh_failed');
    if (!Array.isArray(refreshResult.operations ?? []) || (refreshResult.operations?.length ?? 0) > 20000)
        throw new Error('finance_portfolio_refresh_invalid');
    const sourceMap = new Map(), quoteMap = new Map();
    for (const raw of refreshResult.operations ?? []) {
        const op = (0, finance_1.validateFinanceOperation)(raw);
        if (op.type === 'source.upsert') {
            const previous = sourceMap.get(op.source.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(op.source))
                throw new Error('finance_portfolio_source_conflict');
            sourceMap.set(op.source.id, op.source);
        }
        else if (op.type === 'quotes.import') {
            for (const quote of op.quotes)
                quoteMap.set(quote.assetId, [...(quoteMap.get(quote.assetId) ?? []), quote]);
        }
        else
            throw new Error('finance_portfolio_refresh_operation_invalid');
    }
    if (refreshResult.status === 'unavailable' && quoteMap.size)
        throw new Error('finance_portfolio_refresh_invalid');
    const warnings = new Set(), usedSources = new Map(), assets = new Map(ws.watchlist.map(asset => [asset.id, asset]));
    const groups = new Map();
    for (const holding of ws.holdings) {
        const asset = assets.get(holding.assetId);
        let group = groups.get(holding.currency);
        if (!group) {
            group = { currency: holding.currency, complete: false, totalValue: null, knownSubtotal: 0, items: [], missingAssetIds: [] };
            groups.set(holding.currency, group);
        }
        const item = { holdingId: holding.id, assetId: asset.id, symbol: asset.symbol, quantity: holding.quantity, price: null, marketValue: null, weight: null, asOf: null, sourceId: null };
        const candidates = quoteMap.get(asset.id) ?? [];
        const quote = candidates[0];
        // Conflicting concurrent observations are not resolved by arbitrary array order.
        const conflict = candidates.some(candidate => JSON.stringify(candidate) !== JSON.stringify(quote));
        const source = quote && sourceMap.get(quote.sourceId);
        let sourceURLValid = false;
        if (source?.url) {
            const url = new URL(source.url);
            sourceURLValid = !url.username && !url.password;
        }
        if (conflict)
            warnings.add('finance_portfolio_quote_conflict');
        if (!conflict && quote && source && source.kind === 'provider' && source.status === 'connected' && sourceURLValid &&
            quote.priceBasis === 'price' && asset.currency !== 'XXX' && quote.currency === asset.currency && source.asOf === quote.asOf) {
            const value = holding.quantity * quote.price;
            if (bounded(value)) {
                item.price = quote.price;
                item.marketValue = value;
                item.asOf = quote.asOf;
                item.sourceId = source.id;
                usedSources.set(source.id, source);
            }
            else
                warnings.add('finance_portfolio_value_out_of_range');
        }
        else if (quote && !conflict)
            warnings.add('finance_portfolio_quote_incompatible');
        group.items.push(item);
    }
    for (const group of groups.values()) {
        group.missingAssetIds = [...new Set(group.items.filter(item => item.marketValue === null).map(item => item.assetId))];
        // Compensation limits summation error; no conversion or monetary rounding changes the literal prices.
        let subtotal = 0, correction = 0;
        for (const item of group.items)
            if (item.marketValue !== null) {
                const adjusted = item.marketValue - correction, next = subtotal + adjusted;
                correction = (next - subtotal) - adjusted;
                subtotal = next;
            }
        if (!bounded(subtotal))
            throw new Error('finance_portfolio_total_out_of_range');
        group.knownSubtotal = subtotal;
        group.complete = !group.missingAssetIds.length;
        group.totalValue = group.complete ? subtotal : null;
        if (group.complete && subtotal > 0)
            for (const item of group.items)
                item.weight = item.marketValue / subtotal;
        if (!group.complete)
            warnings.add('finance_portfolio_incomplete_currency_group');
        if (group.complete && subtotal === 0)
            warnings.add('finance_portfolio_zero_total_weights_undefined');
        if (new Set(group.items.filter(item => item.asOf).map(item => item.asOf)).size > 1)
            warnings.add('finance_portfolio_mixed_observation_dates');
    }
    const items = [...groups.values()].flatMap(group => group.items), pricedPositions = items.filter(item => item.marketValue !== null).length;
    if (groups.size > 1)
        warnings.add('finance_portfolio_currencies_not_aggregated');
    if (pricedPositions < items.length)
        warnings.add('finance_portfolio_refresh_coverage_partial');
    const sources = [...usedSources.values()];
    return { status: !pricedPositions ? 'unavailable' : pricedPositions === items.length ? 'ok' : 'partial', baseRevision: ws.revision,
        asOf: common(items.map(item => item.asOf)), retrievedAt: sources.length ? sources.map(source => source.retrievedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) : null,
        groups: [...groups.values()], sources, warnings: [...warnings], providerMessage: refreshResult.message,
        coverage: { positions: items.length, pricedPositions, missingPositions: items.length - pricedPositions } };
}
/** Freeze observed monetary values and their original provenance without importing quotes into the workspace. */
function financePortfolioValuationArtifact(result, workspace, presentation = {}) {
    const ws = (0, finance_1.validateFinanceWorkspace)(workspace);
    if (result.baseRevision !== ws.revision)
        throw new Error('finance_portfolio_refresh_revision_conflict');
    const groups = result.groups.filter(group => group.complete && group.totalValue !== null && group.totalValue > 0);
    if (!groups.length)
        throw new Error('finance_portfolio_no_verified_values');
    const title = (presentation.title ?? 'Portfolio value').slice(0, 300), language = presentation.language ? finance_1.FinanceReportLanguageSchema.parse(presentation.language) : undefined;
    const now = new Date().toISOString(), reportId = (0, finance_1.financeId)('report'), operations = [], sections = [];
    const ids = new Map();
    for (const source of result.sources) {
        const sourceId = (0, finance_1.financeId)('source');
        ids.set(source.id, sourceId);
        operations.push({ type: 'source.upsert', source: { ...source, id: sourceId } });
    }
    if (presentation.narrative?.trim())
        sections.push({ id: (0, finance_1.financeId)('section'), title, kind: 'summary', presentation: 'narrative', narrative: presentation.narrative.slice(0, 20000), widget: null, projection: null });
    for (const group of groups) {
        const amounts = new Map();
        for (const item of group.items) {
            if (item.marketValue === null || !bounded(item.marketValue) || !item.sourceId || !ids.has(item.sourceId))
                throw new Error('finance_portfolio_artifact_invalid');
            const previous = amounts.get(item.assetId);
            const value = (previous?.value ?? 0) + item.marketValue;
            if (!bounded(value))
                throw new Error('finance_portfolio_total_out_of_range');
            amounts.set(item.assetId, { symbol: item.symbol, value });
        }
        if (amounts.size > 500)
            throw new Error('finance_portfolio_chart_capacity_reached');
        const rows = [...amounts].map(([assetId, item]) => [presentation.chartLabels && Object.hasOwn(presentation.chartLabels, assetId) ? presentation.chartLabels[assetId] : item.symbol, item.value]);
        if (rows.some(row => !row[0].trim() || row[0].length > 200) || new Set(rows.map(row => row[0])).size !== rows.length)
            throw new Error('finance_portfolio_display_labels_ambiguous');
        const chartTitle = (presentation.chartTitles?.[group.currency] ?? title).slice(0, 300), widget = (0, finance_1.createFinanceWidget)('chart', chartTitle);
        widget.chartType = 'bar';
        widget.width = 'full';
        widget.metric = 'portfolio:values';
        widget.notes = group.currency;
        sections.push({ id: (0, finance_1.financeId)('section'), title: chartTitle, kind: 'widget', presentation: 'chart', narrative: '', widget, projection: { columns: ['period', 'value'], rows, status: 'ready', warnings: [...result.warnings], asOf: common(group.items.map(item => item.asOf)), sourceIds: [...new Set(group.items.map(item => ids.get(item.sourceId)))] } });
    }
    const frozen = JSON.stringify(result);
    sections.push({ id: (0, finance_1.financeId)('section'), title: 'Observed portfolio snapshot', kind: 'sources', presentation: 'supporting', narrative: '', widget: null, projection: { columns: ['Part', 'Observed record'], rows: Array.from({ length: Math.ceil(frozen.length / 16000) }, (_, index) => [index + 1, frozen.slice(index * 16000, (index + 1) * 16000)]), status: result.status === 'ok' ? 'ready' : 'partial', warnings: [...result.warnings], asOf: result.asOf, sourceIds: [...ids.values()] } });
    const report = { id: reportId, ...(language ? { language } : {}), title, createdAt: now, sourceRevision: ws.revision, reviewPending: true, sections, dashboardSnapshot: null, parentReportId: null };
    operations.push({ type: 'report.add', report });
    return { operations: operations.map(finance_1.validateFinanceOperation), reportId, title, kind: 'chart' };
}


/***/ }),

/***/ 9606:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseDefaultDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
function parseDefaultDef(_def, refs) {
    return {
        ...(0, parseDef_js_1.parseDef)(_def.innerType._def, refs),
        default: _def.defaultValue(),
    };
}
exports.parseDefaultDef = parseDefaultDef;


/***/ }),

/***/ 9729:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseReadonlyDef = void 0;
const parseDef_js_1 = __webpack_require__(3524);
const parseReadonlyDef = (def, refs) => {
    return (0, parseDef_js_1.parseDef)(def.innerType._def, refs);
};
exports.parseReadonlyDef = parseReadonlyDef;


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(7939);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;