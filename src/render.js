/* eslint-disable no-new */
import path from 'path'
import geoViewport from '@mapbox/geo-viewport'
import mbgl from '@mapbox/mapbox-gl-native'
import MBTiles from '@mapbox/mbtiles'
import webRequest from 'request'
import sharp from 'sharp'

const TILE_REGEXP = RegExp('mbtiles://([^/]+)/(\\d+)/(\\d+)/(\\d+)')

/**
 * Very simplistic function that splits out mbtiles service name from the URL
 *
 * @param {String} url - URL to resolve
 */
const resolveNamefromURL = url => url.split('://')[1].split('/')[0]

/**
 * Resolve a URL of a local mbtiles file to a file path
 * Expected to follow this format "mbtiles://<service_name>/*"
 *
 * @param {String} tilePath - path containing mbtiles files
 * @param {String} url - url of a data source in style.json file.
 */
const resolveMBTilesURL = (tilePath, url) => path.format({ root: tilePath, name: resolveNamefromURL(url), ext: '.mbtiles' })

/**
 * Given a URL to a local mbtiles file, get the TileJSON for that to load correct tiles.
 *
 * @param {String} tilePath - path containing mbtiles files.
 * @param {String} url - url of a data source in style.json file.
 * @param {function} callback - function to call with (err, data).
 */
const getTileJSON = (tilePath, url, callback) => {
    const mbtilesFilename = resolveMBTilesURL(tilePath, url)
    const service = resolveNamefromURL(url)

    new MBTiles(mbtilesFilename, (err, mbtiles) => {
        if (err) {
            callback(err)
            return null
        }

        mbtiles.getInfo((infoErr, info) => {
            if (infoErr) {
                callback(infoErr)
                return null
            }

            const {
                minzoom, maxzoom, center, bounds
            } = info

            const tileJSON = {
                tilejson: '1.0.0',
                tiles: [`mbtiles://${service}/{z}/{x}/{y}`],
                minzoom,
                maxzoom,
                center,
                bounds
            }

            callback(null, { data: Buffer.from(JSON.stringify(tileJSON)) })
            return null
        })

        return null
    })
}

/**
 * Fetch a tile from a local mbtiles file.
 *
 * @param {String} tilePath - path containing mbtiles files.
 * @param {String} url - url of a data source in style.json file.
 * @param {function} callback - function to call with (err, data).
 */
const getTile = (tilePath, url, callback) => {
    const matches = url.match(TILE_REGEXP)
    const [z, x, y] = matches.slice(matches.length - 3, matches.length)
    const mbtilesFile = resolveMBTilesURL(tilePath, url)

    new MBTiles(mbtilesFile, (err, mbtiles) => {
        if (err) {
            callback(err)
            return null
        }

        mbtiles.getTile(z, x, y, (tileErr, data) => {
            if (tileErr) {
                console.log(`error fetching tile: z:${z} x:${x} y:${y} from ${mbtilesFile}`)
                callback(null, {})
                return null
            }

            callback(null, { data })
            // if the tile is compressed, unzip it (for vector tiles only!)
            // zlib.unzip(data, (err, data) => {
            //     callback(err, {data})
            // })

            return null
        })

        return null
    })
}

/**
 * Fetch a remotely hosted tile
 *
 * @param {String} url - URL of remote tile
 * @param {function} callback - callback to call with (err, {data})
 */
const getRemoteTile = (url, callback) => {
    webRequest(
        {
            url,
            encoding: null,
            gzip: true
        },
        (err, res, body) => {
            if (err) {
                callback(err)
            } else if (res.statusCode === 200) {
                const response = {}

                if (res.headers.modified) {
                    response.modified = new Date(res.headers.modified)
                }
                if (res.headers.expires) {
                    response.expires = new Date(res.headers.expires)
                }
                if (res.headers.etag) {
                    response.etag = res.headers.etag
                }

                response.data = body

                callback(null, response)
            } else {
                callback(new Error(JSON.parse(body).message))
            }
        }
    )
}

/**
 * Render a map using Mapbox GL, based on layers specified in style.
 * Returns a Promise with the PNG image data as its first parameter for the map image.
 * If zoom and center are not provided, bounds must be provided
 * and will be used to calculate center and zoom based on image dimensions.
 *
 * @param {Object} style - Mapbox GL style object
 * @param {number} width - width of output map (default: 1024)
 * @param {number} height - height of output map (default: 1024)
 * @param {Object} - configuration object containing style, zoom, center: [lng, lat],
 * width, height, bounds: [west, south, east, north]
 * @param {String} tilePath - path to directory containing local mbtiles files that are
 * referenced from the style.json as "mbtiles://<tileset>"
 */
const render = (style, width = 1024, height = 1024, options) => new Promise((resolve) => {
    const { bounds = null, tilePath = null } = options
    let { center = null, zoom = null } = options

    if (!style) {
        throw new Error('style is a required parameter')
    }
    if (!(width && height)) {
        throw new Error('width and height are required parameters and must be non-zero')
    }

    if (center !== null) {
        if (center.length !== 2) {
            throw new Error(`Center must be longitude,latitude.  Invalid value found: ${[...center]}`)
        }

        if (Math.abs(center[0]) > 180) {
            throw new Error(`Center longitude is outside world bounds (-180 to 180 deg): ${center[0]}`)
        }

        if (Math.abs(center[1]) > 90) {
            throw new Error(`Center latitude is outside world bounds (-90 to 90 deg): ${center[1]}`)
        }
    }

    if (zoom !== null && (zoom < 0 || zoom > 22)) {
        throw new Error(`Zoom level is outside supported range (0-22): ${zoom}`)
    }

    if (bounds !== null) {
        if (bounds.length !== 4) {
            throw new Error(`Bounds must be west,south,east,north.  Invalid value found: ${[...bounds]}`)
        }
    }

    // calculate zoom and center from bounds and image dimensions
    if (bounds !== null && (zoom === null || center === null)) {
        const viewport = geoViewport.viewport(bounds, [width, height])
        zoom = Math.max(viewport.zoom - 1, 0)
        /* eslint-disable prefer-destructuring */
        center = viewport.center
    }

    // Options object for configuring loading of map data sources.
    // Note: could not find a way to make this work with mapbox vector sources and styles!
    const mapOptions = {
        request: (req, callback) => {
            const { url, kind } = req
            const isMBTiles = url.startsWith('mbtiles://')

            try {
                switch (kind) {
                    case 2: { // source
                        if (isMBTiles) {
                            getTileJSON(tilePath, url, callback)
                        }
                        // else is not currently handled
                        break
                    }
                    case 3: { // tile
                        if (isMBTiles) {
                            getTile(tilePath, url, callback)
                        } else {
                            getRemoteTile(url, callback)
                        }
                        break
                    }
                }
            } catch (err) {
                console.error(err)
                callback(err)
            }
        }
    }

    const map = new mbgl.Map(mapOptions)
    map.load(style)

    map.render(
        {
            zoom,
            center,
            height,
            width
        },
        (err, buffer) => {
            if (err) throw err

            // Convert raw image buffer to PNG
            return sharp(buffer, { raw: { width, height, channels: 4 } })
                .png()
                .toBuffer()
                .then(resolve)
        }
    )
})

export default render
