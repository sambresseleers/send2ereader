#!/usr/bin/env node

const http = require('http')
const crypto = require('crypto')
const Koa = require('koa')
const Router = require('@koa/router')
const multer = require('@koa/multer')
const logger = require('koa-logger')
const sendfile = require('koa-sendfile')
const serve = require('koa-static')
const { mkdirp } = require('mkdirp')
const fs = require('fs')
const { spawn } = require('child_process')
const { join, extname, basename, dirname } = require('path')
const resolvepath = require('path').resolve
const FileType = require('file-type')
const { transliterate } = require('transliteration')
const sanitize = require('sanitize-filename')

const port = 3001
const expireDelay = 30  // 30 seconds
const maxExpireDuration = 1 * 60 * 60  // 1 hour
const maxFileSize = 1024 * 1024 * 800  // 800 MB

const TYPE_EPUB = 'application/epub+zip'
const TYPE_MOBI = 'application/x-mobipocket-ebook'

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed']
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt']

const keyChars = "23456789ACDEFGHJKLMNPRSTUVWXYZ"
const keyLength = 4

function doTransliterate(filename) {
  let name = filename.split(".")
  const ext = "." + name.splice(-1).join(".")
  name = name.join(".")

  return transliterate(name) + ext
}

function randomKey() {
  let key = ''
  const keyCharsLen = keyChars.length
  const randomBytes = crypto.randomBytes(keyLength)
  for (let i = 0; i < keyLength; i++) {
    key += keyChars[randomBytes[i] % keyCharsLen]
  }
  return key
}


function removeKey (key) {
  console.log('Removing expired key', key)
  const info = app.context.keys.get(key)
  if (info) {
    clearTimeout(app.context.keys.get(key).timer)
    if (info.file) {
      console.log('Deleting file', info.file.path)
      fs.unlink(info.file.path, (err) => {
        if (err) console.error(err)
      })
      info.file = null
    }
    app.context.keys.delete(key)
  } else {
    console.log('Tried to remove non-existing key', key)
  }
}

function expireKey (key) {
  const info = app.context.keys.get(key)
  const timer = setTimeout(removeKey, expireDelay * 1000, key)
  if (info) {
    clearTimeout(info.timer)
    info.timer = timer
    info.alive = new Date()
  }
  return timer
}

function flash (ctx, data) {
  ctx.response.status = data.success ? 200 : 400
  if (!data.success) {
    ctx.set("Connection", "close")
  }
  ctx.body = data
}

const app = new Koa()
app.context.keys = new Map()

// Centralized Error Handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.status = err.status || 500
    ctx.body = {
		success: false,
		message: err.message
	}
    ctx.app.emit('error', err, ctx)
  }
});

app.use(logger())

const router = new Router()

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads')
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.floor(Math.random() * 1E9)
      cb(null, file.fieldname + '-' + uniqueSuffix + extname(file.originalname).toLowerCase())
    }
  }),
  limits: {
    fileSize: maxFileSize,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    file.originalname = sanitize(Buffer.from(file.originalname, 'latin1').toString('utf8'))

    console.log('Incoming file:', file)
    const key = req.body.key.toUpperCase()
    if (!app.context.keys.has(key)) {
      console.error('FileFilter: Unknown key: ' + key)
      cb(new Error("Unknown key " + key))
      return
    }
    if ((!allowedTypes.includes(file.mimetype) && file.mimetype != "application/octet-stream") || !allowedExtensions.includes(extname(file.originalname.toLowerCase()).substring(1))) {
      console.error('FileFilter: File is of an invalid type ', file)
			cb(new Error("Invalid filetype: " + file.originalname))
      return
    }
    cb(null, true)
  }
})

router.post('/generate', async ctx => {
  const agent = ctx.get('user-agent')

  let key = null
  let attempts = 0
  console.log('There are currently', ctx.keys.size, 'key(s) in use.')
  console.log('Generating unique key...', ctx.ip, agent)
  do {
    key = randomKey()
    if (attempts > ctx.keys.size * 2) { // Increased attempts threshold
      console.error('Can\'t generate more keys, map is full.', attempts, ctx.keys.size)
      ctx.throw(500, 'Could not generate a unique key.')
      return
    }
    attempts++
  } while (ctx.keys.has(key))

  console.log('Generated key ' + key + ', '+attempts+' attempt(s)')

  const info = {
    created: new Date(),
    agent: agent,
    file: null,
    urls: []
  }
  ctx.keys.set(key, info)
  expireKey(key)
  setTimeout(() => {
    if(ctx.keys.get(key) === info) removeKey(key)
  }, maxExpireDuration * 1000)

  ctx.cookies.set('key', key, {overwrite: true, httpOnly: false, sameSite: 'strict', maxAge: expireDelay * 1000})

  ctx.body = key
})


async function downloadFile (ctx, next) {
  const key = ctx.query.key
  if (!key) {
    await next()
    return
  }

  const filename = decodeURIComponent(ctx.params.filename)
  const info = ctx.keys.get(key)

  if (!info || !info.file || info.file.name !== filename) {
    await next()
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
		ctx.throw(403, "User agent does not match.")
    return
  }
  expireKey(key)
  console.log('Sending file', [info.file.path, info.file.name])
  if (info.agent.includes('Kindle')) {
    ctx.attachment(info.file.name)
  }
  await sendfile(ctx, info.file.path)
}

router.post('/upload', async (ctx, next) => {
  await upload.single('file')(ctx, () => {})

  ctx.res.writeContinue()

  const key = ctx.request.body.key.toUpperCase()

  if (ctx.request.file) {
    console.log('Uploaded file:', ctx.request.file)
  }

  if (!ctx.keys.has(key)) {
    if (ctx.request.file) {
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
    }
		ctx.throw(400, 'Unknown key ' + key)
    return
  }

  const info = ctx.keys.get(key)
  expireKey(key)

  let url = null
  if (ctx.request.body.url) {
    url = ctx.request.body.url.trim()
    if (url.length > 0 && !info.urls.includes(url)) {
      info.urls.push(url)
    }
  }

  let conversion = null
  let filename = ""

  if (ctx.request.file) {
    if (ctx.request.file.size === 0) {
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
			ctx.throw(400, 'Invalid file submitted (empty file)')
      return
    }

    let mimetype = ctx.request.file.mimetype

    const type = await FileType.fromFile(ctx.request.file.path)

    if (mimetype == "application/octet-stream" && type) {
      mimetype = type.mime
    }

    if (mimetype == "application/epub") {
      mimetype = TYPE_EPUB
    }

    if ((!type || !allowedTypes.includes(type.mime)) && !allowedTypes.includes(mimetype)) {
      fs.unlink(ctx.request.file.path, (err) => {
        if (err) console.error(err)
        else console.log('Removed file', ctx.request.file.path)
      })
			ctx.throw(400, 'Uploaded file is of an invalid type: ' + ctx.request.file.originalname + ' (' + (type? type.mime : 'unknown mimetype') + ')')
      return
    }

    let data = null
    filename = ctx.request.file.originalname
    if (ctx.request.body.transliteration) {
      filename = sanitize(doTransliterate(filename))
    }
    if (info.agent.includes('Kindle')) {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
    }

    const conversionPromise = (cmd, args, cwd) => {
        return new Promise((resolve, reject) => {
            let stderr = ''
            const process = spawn(cmd, args, { cwd })

            process.once('error', (err) => {
                reject(new Error(`${cmd} error: ${err.message}`))
            });

            process.stdout.on('data', (data) => {
                console.log(`${cmd}: ${data}`);
            });

            process.stderr.on('data', (data) => {
                stderr += data
                console.error(`${cmd} stderr: ${data}`);
            });

            process.once('close', (code) => {
                if (code !== 0 && !(cmd === 'kindlegen' && code === 1)) {
                    reject(new Error(`${cmd} exited with code ${code}\n${stderr}`))
                } else {
                    resolve()
                }
            });
        })
    }

    try {
        if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && ctx.request.body.kindlegen) {
            conversion = 'kindlegen'
            const outname = ctx.request.file.path.replace(/\.epub$/i, '.mobi')
            filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
            await conversionPromise('kindlegen', [basename(ctx.request.file.path), '-dont_append_source', '-c1', '-o', basename(outname)], dirname(ctx.request.file.path))
            data = outname
        } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && ctx.request.body.kepubify) {
            conversion = 'kepubify'
            const outname = ctx.request.file.path.replace(/\.epub$/i, '.kepub.epub')
            filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')
            await conversionPromise('kepubify', ['-v', '-u', '-o', basename(outname), basename(ctx.request.file.path)], dirname(ctx.request.file.path))
            data = outname
        } else if (mimetype == 'application/pdf' && ctx.request.body.pdfcropmargins) {
            const dir = dirname(ctx.request.file.path)
            const base = basename(ctx.request.file.path, '.pdf')
            const outfile = resolvepath(join(dir, `${base}_cropped.pdf`))
            await conversionPromise('pdfcropmargins', ['-s', '-u', '-o', outfile, basename(ctx.request.file.path)], dirname(ctx.request.file.path))
            data = outfile
        } else {
            data = ctx.request.file.path
        }
    } catch (err) {
        fs.unlink(ctx.request.file.path, (e) => {
            if (e) console.error(e)
            else console.log('Removed file on conversion error', ctx.request.file.path)
        })
        ctx.throw(500, err.message)
    }

    if(data !== ctx.request.file.path) {
        fs.unlink(ctx.request.file.path, (e) => {
            if(e) console.error(e)
        })
    }

    expireKey(key)
    if (info.file && info.file.path) {
      await new Promise((resolve, reject) => fs.unlink(info.file.path, (err) => {
        if (err) return reject(err)
        else console.log('Removed previously uploaded file', info.file.path)
        resolve()
      }))
    }
    info.file = {
      name: filename,
      path: data,
      uploaded: new Date()
    }
  }

  let messages = []
  if (ctx.request.file) {
    ctx.request.file.skip = true
		const deviceType = info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.');
    messages.push(`Upload successful! ${conversion ? `Ebook was converted with ${conversion} and sent` : 'Sent'} to ${deviceType}`);
    messages.push(filename);
  }
  if (url) {
    messages.push("Added url: " + url)
  }

  if (messages.length === 0) {
		ctx.throw(400, 'No file or url selected')
    return
  }

  flash(ctx, {
    message: messages,
    success: true,
    key: key,
    url: url
  })

  await next()
})

router.delete('/file/:key', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.throw(400, 'Unknown key: ' + key)
  }
  info.file = null
  ctx.body = 'ok'
})

router.get('/status/:key', async ctx => {
  const key = ctx.params.key.toUpperCase()
  const info = ctx.keys.get(key)
  if (!info) {
    ctx.response.status = 404
    ctx.body = {error: 'Unknown key'}
    return
  }
  if (info.agent !== ctx.get('user-agent')) {
    console.error("User Agent doesnt match: " + info.agent + " VS " + ctx.get('user-agent'))
		ctx.throw(403, "User agent does not match.")
    return
  }
  expireKey(key)
  ctx.body = {
    alive: info.alive,
    file: info.file ? {
      name: info.file.name,
    } : null,
    urls: info.urls
  }
})

router.get('/receive', async ctx => {
  await sendfile(ctx, 'static/download.html')
})

router.get('/', async ctx => {
  const agent = ctx.get('user-agent')
  console.log(ctx.ip, agent)
  const isEreader = agent.includes('Kobo') || agent.includes('Kindle') || agent.toLowerCase().includes('tolino') || agent.includes('eReader')
  await sendfile(ctx, isEreader ? 'static/download.html' : 'static/upload.html')
})

router.get('/:filename', downloadFile)

app.use(serve("static"))

app.use(router.routes())
app.use(router.allowedMethods())


fs.rm('uploads', {recursive: true}, (err) => {
  if (err && err.code !== 'ENOENT') throw err
  mkdirp('uploads').then (() => {
    const fn = app.callback()
    const server = http.createServer(fn)
    server.on('checkContinue', (req, res) => {
      console.log("check continue!")
      fn(req, res)
    })
    server.listen(port)
    console.log('server is listening on port ' + port)
  })
})